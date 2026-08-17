/*
MIT License — Copyright (c) 2026 Xicord

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software, subject to the MIT terms. THE SOFTWARE IS PROVIDED "AS IS",
WITHOUT WARRANTY OF ANY KIND.
*/
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings, Settings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { classes } from "@utils/misc";
import { openUserProfile } from "@utils/discord";
import { ModalContent as ModalContentRaw, ModalHeader as ModalHeaderRaw, ModalRoot as ModalRootRaw, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { findComponentByCodeLazy, findStoreLazy } from "@webpack";
import { Button, ChannelStore, FluxDispatcher, Forms, GuildMemberStore, GuildStore, IconUtils, Menu, React, RelationshipStore, Select as SelectRaw, SelectedGuildStore, Switch as SwitchRaw, TextInput, Toasts, UserStore, UserUtils } from "@webpack/common";
import type { ComponentType } from "react";

import { clickable } from "./_a11y";
import { MutualsAPI, profileUserId } from "./xicordMutuals";
import { chunkPool, fromPool, fromPooledFriends, fromPrivate, toPool, toPrivate } from "./_sync";
import { initAccountConfig, loadAccountConfig, swapAccountConfig } from "./_accountConfig";
import { WatchAPI } from "./xicordOrbit";
import { VoiceLogAPI } from "./xicordVoiceLog";

const Button2 = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");
const Switch = SwitchRaw as ComponentType<any>;
const Select = SelectRaw as ComponentType<any>;
const ModalRoot = ModalRootRaw as ComponentType<any>;
const ModalHeader = ModalHeaderRaw as ComponentType<any>;
const ModalContent = ModalContentRaw as ComponentType<any>;
const VoiceStateStore = findStoreLazy("VoiceStateStore");

// Every flush re-serialises the whole profile store into settings.json, and that file
// runs well past a megabyte once a few hundred people are tracked. At 5s that write was
// landing constantly while you sat in a call. Batching to 30s cuts it sixfold; the only
// exposure is losing up to 30s of call-time accounting if Discord dies outright, since
// stop() flushes on the way out.
const FLUSH_DELAY = 30000;
const MAX_COMPANIONS = 300;
// ---------------------------------------------------------------------------
// Caps. 0 means NO LIMIT.
//
// These were ceilings picked when a sweep was a slow trickle. They had become the thing
// deciding what gets seen: the roster sat at exactly 20000 with more members already
// loaded than it could hold, and the per-guild cap was ignoring half of a 10177-member
// server. A cap that binds is not a safety net, it is a silent sampling decision.
//
// Zero, not Infinity, because these are compared and passed to slice(): `slice(0, 0)`
// returns NOTHING, so "unlimited" has to be an explicit branch at every use rather than a
// large number that happens to work. Every one of them is tested for the 0 case.
// ---------------------------------------------------------------------------
const NO_LIMIT = 0;
/** Profiles kept on disk. Targets are never evicted regardless. */
const MAX_PROFILES = NO_LIMIT;
/** Members taken from any one guild's loaded list. */
const MEMBER_SWEEP_CAP = NO_LIMIT;
/** People the sweep will queue in total. */
const SWEEP_TOTAL_CAP = NO_LIMIT;
/** People with a proven friendship kept on disk. */
const MAX_FRIEND_MAP = NO_LIMIT;
/** True when a cap is switched off. */
const uncapped = (n: number) => !(n > 0);

const settings = definePluginSettings({
    announceNew: {
        description: "Toast when a target is seen calling with someone new (public servers)",
        type: OptionType.BOOLEAN,
        default: false,
    },
    propagate: {
        description: "Also build dossiers for the people your targets call with, then the people THEY call with, and so on (up to the cap below). Dossier only — it never adds anyone to the Target trait, so no other watcher is affected",
        type: OptionType.BOOLEAN,
        default: true,
        onChange() { trackedDirty = true; }
    },
    scanMembers: {
        description: "When the Dossier is open, also queue the current server's loaded member list for the mutual-friend check. Xicord Mutuals throttles this to one fetch every 2.5s, so a big server fills in slowly rather than all at once",
        type: OptionType.BOOLEAN,
        default: true,
    },
    alwaysSweep: {
        description: "Keep the \"who added who\" sweep running permanently, with no modal open and no button pressed. A run re-arms itself as soon as the last one drains or stalls, so coverage keeps widening from every member Discord streams in. Turn this off to only sweep when you ask for it",
        type: OptionType.BOOLEAN,
        default: true,
    },
    fullGraphNodes: {
        description: "How many people the \"Full dossier\" view draws at once (the best-connected win). Also editable in the Dossier itself. The physics stays cheap even at 400; past ~250 it is the browser drawing that many circles, and readability, that suffer",
        type: OptionType.NUMBER,
        default: 150,
    },
    heavyGraphNodes: {
        description: "Above this many people, the Full dossier is NOT animated inside Discord (which gets laggy) — instead it offers to open the standalone dashboard, which renders the same data in your browser where it runs smoothly. Set very high to always render in Discord",
        type: OptionType.NUMBER,
        default: 90,
    },
    dashboardUrl: {
        description: "URL of the local Xicord Dashboard (started by start.bat). Used by the \"Open in dashboard\" button",
        type: OptionType.STRING,
        default: "http://localhost:8787",
    },
    maxTracked: {
        description: "Most people to track at once when propagating (targets always come first; beyond this, the weakest call-links are dropped)",
        type: OptionType.SLIDER,
        markers: [25, 50, 100, 150, 200, 300, 500],
        default: 150,
        stickToMarkers: true,
        onChange() { trackedDirty = true; }
    },
    syncUrl: {
        description: "Xicord Sync server. Your dossier is uploaded here so other machines — and your phone — see the same data",
        type: OptionType.STRING,
        default: "https://xicord-sync-production.up.railway.app",
    },
    syncToken: {
        description: "Device token from signing in on the sync server",
        type: OptionType.STRING,
        default: "",
    },
    syncEnabled: {
        description: "Send this machine's dossier to the sync server, and merge in what other machines have sent. Off by default: this uploads records about other people to a server on the internet",
        type: OptionType.BOOLEAN,
        default: false,
    },
    syncMyIds: {
        description: "Your own Discord account ids, comma separated. These are never uploaded — you are in every call you join, so including yourself would say nothing",
        type: OptionType.STRING,
        default: "",
    },
    profiles: {
        // Kept only so an existing install (or a Xicord Cache restore of an old backup)
        // still has something to migrate from. Emptied once load() moves it across.
        description: "Legacy profile store — migrated into IndexedDB on start, then cleared",
        type: OptionType.STRING,
        default: "",
    },
});

interface Companion { count: number; ms: number; last: number; }
interface GameStat { ms: number; last: number; sessions: number; }
interface Profile {
    companions: Record<string, Companion>;
    guilds: Record<string, number>;
    // per-game accumulated play time observed via presence (games this person ran)
    games?: Record<string, GameStat>;
    updated: number;
    firstSeen: number;
}
type Profiles = Record<string, Profile>;
const MAX_GAMES = 60;

let active = false;
let dirty = false;
let flushTimer: any = null;
let profiles: Profiles = {};

// per-target open overlap: which companions are currently in the target's public
// VC and since when
interface Open { channelId: string; guildId: string; companions: Map<string, number>; }
const open = new Map<string, Open>();

// per-person currently-open game session: the game they're playing and since when
const openGame = new Map<string, { name: string; since: number; }>();

// Who we build dossiers for. Without propagation that's exactly the Target trait;
// with it, we walk outward through the recorded call graph — targets, then their
// companions, then theirs — strongest links first, stopping at the cap.
// Dossier-only: nobody here is ever added to the Target trait.
let tracked = new Set<string>();
let trackedDirty = true;

function recomputeTracked() {
    trackedDirty = false;
    retrackWanted = false;
    lastRetrack = Date.now();
    const me = UserStore.getCurrentUser()?.id;
    const cap = Math.max(1, Number(settings.store.maxTracked) || 150);
    const out = new Set<string>();

    for (const id of WatchAPI.list()) {
        if (out.size >= cap) break;
        if (id && id !== me) out.add(id);
    }

    if (settings.store.propagate) {
        let frontier = [...out];
        // Breadth-first, so nearer hops always win a contested cap slot
        while (frontier.length && out.size < cap) {
            const next: Array<{ id: string; count: number; }> = [];
            for (const id of frontier) {
                const comps = profiles[id]?.companions;
                if (!comps) continue;
                for (const c of Object.keys(comps)) {
                    if (c === me || out.has(c)) continue;
                    next.push({ id: c, count: comps[c]?.count ?? 0 });
                }
            }
            // strongest call-link first, so the cap drops the weakest
            next.sort((a, b) => b.count - a.count);
            const added: string[] = [];
            for (const n of next) {
                if (out.size >= cap) break;
                if (out.has(n.id)) continue;
                out.add(n.id);
                added.push(n.id);
            }
            frontier = added;
        }
    }
    tracked = out;
}

// Rebuilding the propagated set is a breadth-first walk of the whole call graph, and
// trackedSet() is consulted on EVERY voice-state update — so marking it dirty the moment
// a new companion appeared meant a full walk per event in a busy server. Marking it
// never, though, strands newly-seen people outside the set forever: they stay a line in
// somebody else's profile and never get a log of their own until a restart. So new edges
// only ask for a refresh, and the walk runs at most once a minute.
const RETRACK_INTERVAL = 60_000;
let retrackWanted = false;
let lastRetrack = 0;

/** A new edge appeared: widen the set soon, but not on this event. */
function noteCallGraphGrew() { retrackWanted = true; }

function trackedSet(): Set<string> {
    if (trackedDirty) recomputeTracked();
    else if (retrackWanted && Date.now() - lastRetrack >= RETRACK_INTERVAL) recomputeTracked();
    return tracked;
}

/** The Target trait changed, so the propagation seeds did too. */
const onWatchChanged = () => { trackedDirty = true; };

/**
 * Queue a mutual-friends scan for these people. Xicord Mutuals throttles and caches
 * the actual fetching, so this is safe to call with a long list — anyone already
 * scanned is skipped there.
 */
function scanForMutuals(ids: string[]) {
    try {
        if (!MutualsAPI.isActive()) return;
        const me = UserStore.getCurrentUser()?.id;
        for (const id of ids) {
            if (!id || id === me || MutualsAPI.isScanned(id)) continue;
            MutualsAPI.scan(id);
        }
    } catch { }
}

/** Everyone the guild's loaded member list knows about, for the mutual check. */
function guildMemberIds(guildId?: string | null): string[] {
    if (!guildId) return [];
    try {
        const ids = (GuildMemberStore as any).getMemberIds?.(guildId);
        return Array.isArray(ids) ? ids : [];
    } catch { return []; }
}

// Sweep each guild's loaded member list ONCE, then stay current via
// GUILD_MEMBER_ADD, rather than re-slicing the same list on every modal open.
const sweptGuilds = new Set<string>();
function sweepGuildMembers(guildId?: string | null) {
    if (!guildId || sweptGuilds.has(guildId)) return;
    sweptGuilds.add(guildId);
    // Mutuals dedupes and throttles, so nobody is fetched twice. NOTE the branch:
    // slice(0, 0) returns an empty array, so an uncapped sweep must not go through it.
    const members = guildMemberIds(guildId);
    scanForMutuals(uncapped(MEMBER_SWEEP_CAP) ? members : members.slice(0, MEMBER_SWEEP_CAP));
}
const onGuildMemberAdd = (e: any) => {
    if (!active || !settings.store.scanMembers) return;
    const id = e?.userId ?? e?.user?.id;
    if (id) scanForMutuals([id]);
};

// ---------------------------------------------------------------------------
// All-server friend sweep
//
// Discord never hands out somebody else's friend list, so the only friendships a
// client can PROVE are mutual ones — people who are friends with you as well. The
// sweep walks every server's loaded member list, runs each person through the Mutuals
// scanner, and keeps everyone who came back with at least one name. Those are the
// people we can honestly say "has someone added" about.
// ---------------------------------------------------------------------------

export interface FriendRow {
    id: string;
    /** Proven friends — people this person and you have both added */
    friends: string[];
    /** Servers this person was found in while sweeping */
    guilds: string[];
}
interface FriendEntry { friends: string[]; guilds: string[]; at: number; }
type FriendMapStore = Record<string, FriendEntry>;

/**
 * Every member of every server, deduped, remembering which servers each was found in.
 * You and bots are dropped: a bot has no friend list, and your own is not news.
 */
export function collectAllMembers(
    guildIds: string[],
    membersOf: (guildId: string) => string[],
    meId?: string | null,
    isBot: (id: string) => boolean = () => false,
    perGuildCap = MEMBER_SWEEP_CAP,
    totalCap = SWEEP_TOTAL_CAP
): Map<string, string[]> {
    const seen = new Map<string, string[]>();
    for (const guildId of guildIds) {
        if (!guildId) continue;
        let taken = 0;
        for (const id of membersOf(guildId) ?? []) {
            if (!uncapped(perGuildCap) && taken >= perGuildCap) break;
            if (!id || id === meId || isBot(id)) continue;
            taken++;
            const at = seen.get(id);
            if (at) {
                if (!at.includes(guildId)) at.push(guildId);
                continue;
            }
            // The total cap bounds the QUEUE, so it counts distinct people. Someone
            // already seen elsewhere costs no extra fetch, so their second server is
            // still recorded after the cap is reached.
            if (!uncapped(totalCap) && seen.size >= totalCap) continue;
            seen.set(id, [guildId]);
        }
    }
    return seen;
}

/**
 * The sweep's answer: everyone we can prove has added someone. A person the scanner
 * has not answered for yet counts as PENDING, never as "has nobody" — a half-finished
 * sweep reporting zeros would read as a confident finding of nothing.
 */
export function buildFriendMap(
    seen: Map<string, string[]>,
    mutualsOf: (id: string) => string[] | null,
    meId?: string | null
): { rows: FriendRow[]; cleared: string[]; scanned: number; pending: number; total: number; } {
    const rows: FriendRow[] = [];
    // Answered, but with nobody we can see. Reported separately rather than merely
    // skipped: a stored finding has to be RETRACTABLE, or an unfriending would leave a
    // gold "proven friendship" ring on the graph for good.
    const cleared: string[] = [];
    let scanned = 0;
    let total = 0;
    for (const [id, guilds] of seen) {
        if (!id || id === meId) continue;
        total++;
        const friends = mutualsOf(id);
        if (friends == null) continue; // not looked up yet
        scanned++;
        const clean = friends.filter(f => f && f !== meId);
        if (!clean.length) { cleared.push(id); continue; }
        rows.push({ id, friends: clean, guilds: [...guilds] });
    }
    return { rows: sortFriendRows(rows), cleared, scanned, pending: total - scanned, total };
}

export interface WhoAddedRow { id: string; guilds: string[]; }
interface WhoAddedResult { rows: WhoAddedRow[]; scanned: number; pending: number; total: number; }

/** Most servers first, then a stable tiebreak on ID. */
export function sortWhoAddedRows(rows: WhoAddedRow[]): WhoAddedRow[] {
    return [...rows].sort((a, b) =>
        b.guilds.length - a.guilds.length
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The inverse of the friend map: of everyone swept, who has TARGET added?
 *
 * `buildFriendMap` reads "person → friends they added"; this reads it backwards for one
 * person. The data is the same proven-mutual friendships, so the same honesty rules
 * apply: someone the scanner has not answered for yet is PENDING, never a silent "no",
 * or a half-run sweep would look like a confident finding of nobody.
 *
 * A real consequence of how mutual friends are computed: TARGET can only ever appear in
 * someone's proven-friends list if TARGET is also YOUR friend. So a non-friend target
 * simply comes back empty — an honest answer the data already encodes, not a bug.
 */
export function whoAdded(
    target: string,
    candidateIds: Iterable<string>,
    provenFriendsOf: (id: string) => Set<string> | null,
    guildsOf: (id: string) => string[],
    meId?: string | null
): WhoAddedResult {
    const rows: WhoAddedRow[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    let total = 0;
    for (const id of candidateIds) {
        if (!id || id === target || id === meId || seen.has(id)) continue;
        seen.add(id);
        total++;
        const friends = provenFriendsOf(id);
        if (friends == null) continue; // not looked up yet → pending
        scanned++;
        if (friends.has(target)) rows.push({ id, guilds: [...(guildsOf(id) ?? [])] });
    }
    return { rows: sortWhoAddedRows(rows), scanned, pending: total - scanned, total };
}

/** Most friends first, then most servers, then a stable tiebreak on ID. */
export function sortFriendRows(rows: FriendRow[]): FriendRow[] {
    return [...rows].sort((a, b) =>
        b.friends.length - a.friends.length
        || b.guilds.length - a.guilds.length
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Fold a sweep's rows into the stored map. Findings have to persist across restarts
 * because the Mutuals cache does not — it lives in memory only, so without this every
 * restart would begin the hours-long sweep again from nothing on screen.
 */
export function mergeFriendMap(
    prev: FriendMapStore,
    rows: FriendRow[],
    now: number,
    cap = MAX_FRIEND_MAP,
    cleared: string[] = []
): FriendMapStore {
    const out: FriendMapStore = { ...prev };
    // A fresh answer of "nobody" retires the old finding. Without this the store only
    // ever accumulated positives, so unfriending someone left the claim standing —
    // and after a restart, with the memory-only scan cache empty, that stale claim is
    // exactly what the graph falls back to.
    for (const id of cleared) delete out[id];
    for (const r of rows) {
        const old = out[r.id];
        // Servers accumulate. A sweep only sees the member lists Discord happens to
        // have loaded, so replacing the list outright would make "seen in" flicker
        // between runs as different parts of a server are cached.
        const guilds = old ? [...new Set([...(old.guilds ?? []), ...r.guilds])] : [...r.guilds];
        out[r.id] = { friends: [...r.friends], guilds, at: now };
    }
    const ids = Object.keys(out);
    if (!uncapped(cap) && ids.length > cap) {
        ids.sort((a, b) => (out[b]?.at ?? 0) - (out[a]?.at ?? 0));
        for (const id of ids.slice(cap)) delete out[id];
    }
    return out;
}

/** Stored map back to display rows, newest findings ordered the same way as a sweep. */
export function storedFriendRows(store: FriendMapStore): FriendRow[] {
    return sortFriendRows(Object.entries(store ?? {})
        .map(([id, r]) => ({ id, friends: r?.friends ?? [], guilds: r?.guilds ?? [] }))
        .filter(r => r.friends.length > 0));
}

/**
 * The friend map as a NETWORK: your friends at the centre of their own orbits, and every
 * person proven to have added them hanging off.
 *
 * The list answers "who added someone"; this answers "who is clustered around whom", which
 * a list physically cannot show — two people who added the same three friends sit together
 * here and are fifty rows apart there.
 *
 * The edges are friendships, not calls, so this graph means something different from the
 * dossier's: an edge here is a proven mutual friendship, and the only reason any of them
 * are visible is that YOUR friend is one end of it.
 *
 * `limit` caps the PEOPLE drawn, keeping the best-connected. Your friends are never cut —
 * they are the hubs, and dropping one would silently orphan everyone who added them.
 */
export function buildFriendGraph(
    rows: FriendRow[],
    limit = 150
): { hubs: string[]; people: string[]; edges: Array<[string, string]>; total: number; } {
    const degree = new Map<string, number>();
    const hubSet = new Set<string>();
    for (const r of rows) {
        for (const f of r.friends) {
            hubSet.add(f);
            degree.set(f, (degree.get(f) ?? 0) + 1);
        }
        degree.set(r.id, (degree.get(r.id) ?? 0) + r.friends.length);
    }
    // best-connected people win a place; hubs are exempt from the cap
    const people = rows.map(r => r.id)
        .filter(id => !hubSet.has(id))
        .sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || (a < b ? -1 : 1));
    const kept = new Set(people.slice(0, Math.max(0, limit)));
    const edges: Array<[string, string]> = [];
    for (const r of rows) {
        if (!kept.has(r.id) && !hubSet.has(r.id)) continue;
        for (const f of r.friends) edges.push([r.id, f]);
    }
    return {
        hubs: [...hubSet].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0)),
        people: [...kept],
        edges,
        total: people.length
    };
}

/**
 * Filter the friend map for the panel's search box. Matches the person, but also the
 * friends they added — "who here added Bob?" is the question this view exists for.
 */
export function filterFriendRows(
    rows: FriendRow[],
    query: string,
    nameOf: (id: string) => string
): FriendRow[] {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    /*
     * One lower-cased name per distinct id, for the length of this call.
     *
     * The scan is rows × their friends, with a user-store lookup and a fresh lowercase
     * allocation at every step. Your friends are what the rows have in COMMON, so the same
     * handful of ids were being looked up and lower-cased thousands of times over. The
     * cache is per call rather than kept: a name that resolves in the background then still
     * shows up on the next keystroke, exactly as before.
     */
    const seen = new Map<string, string>();
    const lower = (id: string) => {
        let v = seen.get(id);
        if (v === undefined) { v = nameOf(id).toLowerCase(); seen.set(id, v); }
        return v;
    };
    // ids are lower-cased too — the query already is, so anything but a bare numeric
    // snowflake would silently never match on id
    return rows.filter(r =>
        r.id.toLowerCase().includes(q)
        || lower(r.id).includes(q)
        || r.friends.some(f => f.toLowerCase().includes(q) || lower(f).includes(q)));
}

const FRIENDS_KEY = "XicordDossierFriendMap";
const friendsKeyFor = (id: string | null) => (id ? `${FRIENDS_KEY}:${id}` : FRIENDS_KEY);
// Per-ACCOUNT, for the same reason the Mutuals cache is: a mutual friend is measured
// from whoever is logged in, so another account's answers are simply wrong here.
let friendMap: FriendMapStore = {};
let friendsDirty = false;
let friendsTimer: any = null;

/** userId -> servers found in, for the sweep currently on screen. */
let sweepSeen = new Map<string, string[]>();
let sweeping = false;
let sweepStarted = 0;
// How many of this sweep's people have been answered for, and when that last moved.
// Generous, because the queue is shared: another consumer's backlog can legitimately
// stall ours for minutes without the run being over.
let sweepScanned = 0;
let lastSweepProgress = 0;
const SWEEP_STALL = 5 * 60 * 1000;
const sweepListeners = new Set<() => void>();
// Bumped whenever the sweep state or the stored findings change, so the panel can
// memoise: sorting and filtering up to MAX_FRIEND_MAP rows on every keystroke, while
// the modal's own 4s tick re-renders anyway, is real typing lag on a big store.
let sweepVersion = 0;
function notifySweep() {
    sweepVersion++;
    sweepListeners.forEach(l => { try { l(); } catch { } });
}

function mutualsOf(id: string): string[] | null {
    try { return MutualsAPI.isActive() ? MutualsAPI.getMutuals(id) : null; } catch { return null; }
}

// What OTHER contributors proved, pulled from the shared pool. Kept apart from friendMap
// on purpose: that one is what this machine proved and what gets pushed back, and mixing
// them would re-push other people's findings as our own until everybody vouched for
// everything. See fromPooledFriends().
const POOLED_KEY = "XicordPooledFriends";
type PooledFriends = Record<string, { friends: string[]; guilds: string[]; at: number; sources: number; }>;
let pooledFriends: PooledFriends = {};
let pooledDirty = false;
let pooledTimer: any = null;

function schedulePooledFlush() {
    pooledDirty = true;
    if (pooledTimer != null) return;
    pooledTimer = setTimeout(flushPooled, FLUSH_DELAY);
}
function flushPooled() {
    if (pooledTimer != null) { clearTimeout(pooledTimer); pooledTimer = null; }
    if (!pooledDirty) return;
    pooledDirty = false;
    const writing = pooledFriends;
    void DataStore.set(POOLED_KEY, writing).catch(e => {
        if (writing === pooledFriends) pooledDirty = true;
        console.error("Xicord Dossier: pooled friends save failed", e);
    });
}

/** Everything the pool knows, for the dashboard snapshot and the panels. */
export function getPooledFriends(): PooledFriends {
    const out: PooledFriends = {};
    for (const [id, r] of Object.entries(pooledFriends)) if (r?.friends?.length) out[id] = { ...r };
    return out;
}

/**
 * Proven friends of someone: what THIS machine can show, plus what the pool contributed.
 *
 * The union is the honest answer. Your own scan only ever sees `friends(you) ∩ friends(X)`,
 * so another contributor seeing a name you cannot is not a contradiction — it is the
 * point of pooling. Equally, your own scan losing a name only retracts YOUR claim; if
 * somebody else can still prove it, it stays.
 */
function provenFriends(id: string): Set<string> | null {
    const out = new Set<string>();
    const live = mutualsOf(id);
    if (live) for (const f of live) out.add(f);
    else for (const f of friendMap[id]?.friends ?? []) out.add(f);
    for (const f of pooledFriends[id]?.friends ?? []) out.add(f);
    return out.size ? out : null;
}

/**
 * Everyone this client could answer "who added TARGET" about — the union of the roster,
 * this session's sweep, our own findings and the pool. It is the candidate set fed to
 * whoAdded(); a name only becomes a real result once provenFriends() proves TARGET is on
 * their list.
 */
function whoAddedCandidates(): Set<string> {
    const out = new Set<string>();
    for (const id of Object.keys(roster)) out.add(id);
    for (const id of sweepSeen.keys()) out.add(id);
    for (const id of Object.keys(friendMap)) out.add(id);
    for (const id of Object.keys(pooledFriends)) out.add(id);
    return out;
}

/** Servers a candidate was seen in, for a whoAdded row. */
function guildsForCandidate(id: string): string[] {
    return friendMap[id]?.guilds ?? roster[id]?.guilds ?? sweepSeen.get(id) ?? pooledFriends[id]?.guilds ?? [];
}

/** Just the pool's half, so the UI can say which findings are not this machine's. */
function pooledOnly(id: string): string[] {
    const mine = new Set(mutualsOf(id) ?? friendMap[id]?.friends ?? []);
    return (pooledFriends[id]?.friends ?? []).filter(f => !mine.has(f));
}

/**
 * "Calls with", ordered so the people the subject has actually ADDED float to the top,
 * most recently in a call with them first.
 *
 * The two halves are deliberately sorted on different keys. Among proven friends the
 * useful question is "who are they still around", so it is recency. Below that the list
 * reverts to weight — times seen together, then time spent — because for someone with no
 * provable friendship a single recent hello should not outrank a hundred hours.
 *
 * `friends` is null when nobody has scanned this person yet. That is NOT "they have
 * added nobody": everyone stays in the old weight order rather than being silently
 * presented as having no friendships.
 */
export function orderCompanions(
    entries: Array<[string, Companion]>,
    friends?: Set<string> | null
): Array<{ id: string; rec: Companion; added: boolean; }> {
    const rows = entries.map(([id, rec]) => ({ id, rec, added: !!friends?.has(id) }));
    return rows.sort((a, b) =>
        (b.added ? 1 : 0) - (a.added ? 1 : 0)
        || (a.added
            ? (b.rec.last ?? 0) - (a.rec.last ?? 0)
            : (b.rec.count ?? 0) - (a.rec.count ?? 0) || (b.rec.ms ?? 0) - (a.rec.ms ?? 0))
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function allGuildIds(): string[] {
    try { return Object.keys((GuildStore as any).getGuilds?.() ?? {}); } catch { return []; }
}

function isBotUser(id: string): boolean {
    try { return !!UserStore.getUser(id)?.bot; } catch { return false; }
}

/**
 * Servers with a loaded member list, biggest first, with how many people the client
 * ACTUALLY holds for each.
 *
 * That count is the whole story behind "why did it only sweep 1300?". Discord never
 * sends the full membership of a large server — the sidebar loads in ranges as you
 * scroll, and getMemberIds() returns only what has arrived. A 130k-member server
 * typically contributes a couple of hundred. Showing the real number per server means
 * the sweep can be aimed at one that actually has people loaded, and stops the total
 * looking like a bug.
 */
export function sweepableGuilds(
    guildIds: string[],
    membersOf: (guildId: string) => string[],
    nameOf: (guildId: string) => string,
    meId?: string | null,
    isBot: (id: string) => boolean = () => false
): Array<{ id: string; name: string; loaded: number; }> {
    const out: Array<{ id: string; name: string; loaded: number; }> = [];
    for (const id of guildIds) {
        if (!id) continue;
        let loaded = 0;
        for (const m of membersOf(id) ?? []) {
            if (!m || m === meId || isBot(m)) continue;
            loaded++;
        }
        if (loaded) out.push({ id, name: nameOf(id), loaded });
    }
    return out.sort((a, b) => b.loaded - a.loaded || a.name.localeCompare(b.name));
}

function guildName(id: string): string {
    try { return (GuildStore as any).getGuild?.(id)?.name ?? "a server"; } catch { return "a server"; }
}

/**
 * The members of `guildId` the roster has never seen before.
 *
 * Discord never sends a big server's full membership — the list arrives in ranges as you
 * scroll it. So the useful moment to widen is exactly when that happens, and the useful
 * amount to widen by is only the arrivals: re-walking a 1400-member list on every scroll
 * event would rebuild the same map dozens of times a minute to learn nothing.
 */
export function newMembers(
    store: Roster,
    memberIds: string[],
    meId?: string | null,
    isBot: (id: string) => boolean = () => false
): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of memberIds ?? []) {
        if (!id || id === meId || seen.has(id) || store[id] || isBot(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/** Which servers the run in progress covers, for the panel's label. */
let sweepGuilds: string[] = [];

// Scrolling a member list fires GUILD_MEMBER_LIST_UPDATE continuously, so the widen is
// coalesced per guild rather than run per event.
const widenPending = new Set<string>();
let widenTimer: any = null;
const WIDEN_DELAY = 3000;

function widenNow() {
    widenTimer = null;
    if (!active) return;
    const me = UserStore.getCurrentUser()?.id ?? null;
    const guilds = [...widenPending];
    widenPending.clear();
    let added = 0;
    for (const g of guilds) {
        const fresh = newMembers(roster, guildMemberIds(g), me, isBotUser);
        if (!fresh.length) continue;
        const found = new Map<string, string[]>();
        for (const id of fresh) found.set(id, [g]);
        added += addToRoster(roster, found, Date.now());
        // While a run is live these join ITS scope rather than being fired straight at
        // Mutuals: widening is the point of streaming members in, and feedSweep() will
        // reach them in turn. Queueing them here instead would put a scroll of the member
        // list ahead of everyone the run has already committed to, and reintroduce the
        // unbounded dump the batching exists to prevent.
        if (sweeping) for (const id of fresh) if (!sweepSeen.has(id)) sweepSeen.set(id, [g]);
    }
    if (added) { scheduleRosterFlush(); notifySweep(); }
}

const onGuildMemberListUpdate = (e: any) => {
    if (!active || !settings.store.scanMembers) return;
    const id = e?.guildId ?? e?.guild_id;
    if (!id) return;
    widenPending.add(id);
    if (widenTimer == null) widenTimer = setTimeout(widenNow, WIDEN_DELAY);
};

// ---------------------------------------------------------------------------
// Feeding Mutuals, a batch at a time
// ---------------------------------------------------------------------------
// A run used to hand Mutuals its ENTIRE scope the instant it started — twenty thousand
// ids in one loop. Nothing was fetched any faster for it (Mutuals paces itself at one
// lookup every ~2.5s regardless), but the queue is FIFO and SHARED with the voice
// scanner, so everything that plugin queued afterwards sat behind a nine-hour backlog.
// Ordering was the whole cost, and it bought nothing.
//
// So the run's scope and the run's queue are now separate things: sweepSeen still says
// who the run is about — it is what the progress line and the who-added view are built
// on — while only a batch at a time is actually in front of Mutuals, topped up on the
// same tick that feeds the roster. Exactly what silentSweepTick already did for the
// ambient backlog, now applied to the run itself.
const SWEEP_BATCH = 60;
// Top up only once the queue has genuinely nearly drained, rather than whenever it is
// merely under a batch — otherwise every tick tops a half-full queue back up and the
// depth creeps. Two constants because they are two different decisions: how deep a slice
// is, and how empty the queue has to be before another one is cut. Together they bound
// the queue at SWEEP_LOW_WATER + SWEEP_BATCH, which is the number that matters — it is
// how long anything queued behind the sweep has to wait.
const SWEEP_LOW_WATER = 20;
/** Ids handed to Mutuals during THIS run, so a top-up does not re-offer the same slice. */
const sweepHanded = new Set<string>();

/**
 * The next slice of a run to hand over: people it covers that nobody has an answer for
 * and that this run has not already offered, in the order they were found.
 *
 * Pure, so the batching is testable without a Mutuals queue: the bug it guards is a
 * top-up that keeps re-offering the first 60 and never advances past them.
 */
export function nextSweepBatch(
    seen: Map<string, string[]>,
    isScanned: (id: string) => boolean,
    handed: Set<string>,
    limit: number
): string[] {
    const out: string[] = [];
    for (const id of seen.keys()) {
        if (!id || handed.has(id) || isScanned(id)) continue;
        out.push(id);
        if (out.length >= limit) break;
    }
    return out;
}

/**
 * Top the queue up from the run in progress. Returns how many were handed over.
 *
 * Gated on the queue being nearly drained, so the sweep never buries an interactive
 * lookup — and only ever a batch deep, so `cancel()` on stop still releases in one go.
 */
function feedSweep(): number {
    if (!sweeping || !sweepSeen.size) return 0;
    try {
        if (!MutualsAPI.isActive()) return 0;
        if (MutualsAPI.pendingCount() > SWEEP_LOW_WATER) return 0;
        const batch = nextSweepBatch(sweepSeen, id => MutualsAPI.isScanned(id), sweepHanded, SWEEP_BATCH);
        for (const id of batch) { sweepHanded.add(id); MutualsAPI.scan(id); }
        return batch.length;
    } catch { return 0; }
}

/** `guildIds` limits the run to those servers; omit it to sweep everything loaded. */
function startServerSweep(guildIds?: string[]): boolean {
    if (!MutualsAPI.isActive()) return false;
    // Any start is a start: the automatic tick never reaches here while paused, so this
    // can only be an explicit one, and asking for a sweep means you want them again.
    autoSweepPaused = false;
    const me = UserStore.getCurrentUser()?.id ?? null;
    const targets = guildIds?.length ? guildIds : allGuildIds();
    sweepGuilds = targets;
    // One server gets the whole per-guild budget rather than a share of it: aiming the
    // sweep is the point, so it should exhaust what is loaded there.
    sweepSeen = collectAllMembers(targets, guildMemberIds, me, isBotUser);
    // a click's findings join the roster too, so they outlive the session
    if (addToRoster(roster, sweepSeen, Date.now())) scheduleRosterFlush();
    // No servers with a loaded member list is a finished sweep of nothing, not a run
    // that sits on "Sweeping…" forever with no queue behind it.
    sweeping = sweepSeen.size > 0;
    sweepStarted = Date.now();
    sweepScanned = 0;
    lastSweepProgress = Date.now();
    // A fresh run re-offers everyone: the people a previous one left unanswered are
    // exactly the ones a retry is for, and Mutuals' own backoff decides when they are
    // actually re-fetched.
    sweepHanded.clear();
    feedSweep();
    harvestSweep();
    notifySweep();
    return true;
}

function stopServerSweep() {
    sweeping = false;
    // Only the not-yet-fetched are dropped; everything already learned stays.
    try { MutualsAPI.cancel([...sweepSeen.keys()]); } catch { }
    sweepHanded.clear();
    notifySweep();
}

// ---------------------------------------------------------------------------
// The sweep as a permanent job
// ---------------------------------------------------------------------------
// A run used to exist only while someone was watching it: the "Find Who Added Them"
// modal started one on open and cancelled the queue on close, and the panel's button was
// the only other way in. So the answer to "who added who" stopped improving the moment
// you looked away, which is exactly backwards — it is a job measured in hours, and the
// modal is open for seconds.
//
// This re-arms a run whenever the last one has drained or stalled. Guarded on `sweeping`
// rather than restarting unconditionally: a run's end is detected by its own progress
// going quiet (see harvestSweep), and kicking it every minute would reset that clock
// forever, so no run would ever be considered finished and the panel would sit on
// "Sweeping…" for the rest of the session.
//
// This is not the same job as silentSweepTick(). That one trickles the ROSTER into
// Mutuals a batch at a time and never touches `sweepSeen`, so it feeds no progress and
// no ETA. This one is the real sweep — the set the "who added" view and the panel are
// both built on — just no longer waiting to be asked.
const AUTO_SWEEP_TICK = 60000;
let autoSweepTimer: any = null;
// The panel's "Stop" has to still mean something now that runs restart themselves: it
// pauses the automatic ones for this session. Pressing either Sweep button, or opening
// the who-added view, resumes them — startServerSweep clears this, and the tick below
// checks it before ever getting there.
let autoSweepPaused = false;

function autoSweepTick() {
    if (!active || !loaded) return;
    if (!settings.store.alwaysSweep || autoSweepPaused) return;
    if (sweeping) return;
    try { startServerSweep(); } catch { }
}

// ---------------------------------------------------------------------------
// The roster: everyone worth asking Mutuals about, kept on disk
// ---------------------------------------------------------------------------
// `sweepSeen` was memory-only and only ever filled by pressing the button, so the list
// of people to check died on every restart and a sweep could only cover whoever happened
// to be loaded at the moment of the click. Discord hands the client members steadily —
// as you scroll a member list, as people join, as they appear in voice — so the roster
// accumulates instead, survives restarts, and is worked through quietly in the
// background whether or not the modal is open.
const ROSTER_KEY = "XicordDossierRoster";
type Roster = Record<string, { guilds: string[]; at: number; }>;
let roster: Roster = {};
let rosterDirty = false;
let rosterTimer: any = null;

const rosterKeyFor = (id: string | null) => (id ? `${ROSTER_KEY}:${id}` : ROSTER_KEY);

function scheduleRosterFlush() {
    rosterDirty = true;
    if (rosterTimer != null) return;
    rosterTimer = setTimeout(flushRoster, FLUSH_DELAY);
}
function flushRoster() {
    if (rosterTimer != null) { clearTimeout(rosterTimer); rosterTimer = null; }
    if (!rosterDirty || !loaded) return;
    rosterDirty = false;
    const key = rosterKeyFor(accountId);
    const writing = roster;
    void DataStore.set(key, writing).catch(e => {
        if (writing === roster) rosterDirty = true;
        console.error("Xicord Dossier: roster save failed", e);
    });
}

/**
 * Fold newly-visible members into the roster. Returns how many people are genuinely new,
 * so a caller can tell "nothing changed" from "found 800 more".
 *
 * Pure apart from the store it is handed, so the cap and the guild-merging are testable.
 */
export function addToRoster(store: Roster, found: Map<string, string[]>, now: number, cap = SWEEP_TOTAL_CAP): number {
    let added = 0;
    for (const [id, guilds] of found) {
        const have = store[id];
        if (have) {
            for (const g of guilds) if (!have.guilds.includes(g)) have.guilds.push(g);
            continue;
        }
        if (!uncapped(cap) && Object.keys(store).length >= cap) {
            // Full: drop the least recently added to make room, so a long-running client
            // keeps drifting towards the people it is actually seeing now.
            let oldest: string | null = null, oldestAt = Infinity;
            for (const [k, v] of Object.entries(store)) if (v.at < oldestAt) { oldestAt = v.at; oldest = k; }
            if (!oldest || oldestAt >= now) continue;
            delete store[oldest];
        }
        store[id] = { guilds: [...guilds], at: now };
        added++;
    }
    return added;
}

/** Roster entries nobody has a mutual-friend answer for yet, oldest first. */
export function unscannedRoster(store: Roster, isScanned: (id: string) => boolean, limit: number): string[] {
    const out: Array<{ id: string; at: number; }> = [];
    for (const [id, v] of Object.entries(store)) {
        if (isScanned(id)) continue;
        out.push({ id, at: v.at });
    }
    out.sort((a, b) => a.at - b.at);
    return out.slice(0, limit).map(r => r.id);
}

/** Sweep the currently-loaded members of every server into the roster. */
function harvestRoster(): number {
    if (!loaded) return 0;
    const me = UserStore.getCurrentUser()?.id ?? null;
    const found = collectAllMembers(allGuildIds(), guildMemberIds, me, isBotUser);
    const added = addToRoster(roster, found, Date.now());
    if (added) { scheduleRosterFlush(); notifySweep(); }
    return added;
}

// How many to keep in front of Mutuals at once. Its queue is shared with the voice
// scanner and it paces itself, so the job here is only to keep it from running dry —
// dumping 20 000 ids in would starve anything more urgent behind them.
const SILENT_BATCH = 40;
const SILENT_TICK = 20000;
let silentTimer: any = null;

/**
 * Keep Mutuals fed from the roster, quietly, forever. This is what makes a big server
 * finish at all: the button can only queue what is loaded right now, whereas this picks
 * up where it left off across restarts and takes advantage of every member Discord has
 * handed over since.
 */
function silentSweepTick() {
    if (!active || !loaded) return;
    try {
        if (!MutualsAPI.isActive()) return;
        harvestRoster();
        // The run in progress gets the capacity first — it is the job someone is watching
        // a progress bar for. Whatever it leaves, the ambient backlog below takes.
        feedSweep();
        // Only top up when Mutuals is nearly idle, so interactive scans still go first
        if (MutualsAPI.pendingCount() > SILENT_BATCH) return;
        const next = unscannedRoster(roster, id => MutualsAPI.isScanned(id), SILENT_BATCH);
        for (const id of next) MutualsAPI.scan(id);
        harvestRosterAnswers();
    } catch { }
}

/**
 * Fold whatever Mutuals has answered for roster people into the friend map.
 *
 * Deliberately separate from harvestSweep(): that one drives the BUTTON's progress and
 * its "finished" detection off the set the button queued, and running it over the whole
 * roster would leave it permanently unfinished.
 */
function harvestRosterAnswers() {
    if (!loaded) return;
    const me = UserStore.getCurrentUser()?.id ?? null;
    const asMap = new Map<string, string[]>();
    // Filtered here as well as inside foldAnswers, so the common case — a tick where
    // Mutuals has answered for nobody new — does not allocate a 20 000-entry Map to
    // discover that.
    //
    // for..in rather than Object.entries: entries() materialises a 20 000-element array of
    // freshly-allocated pairs before the loop even starts, which measured 5.7ms against
    // 2.9ms for walking the keys — and this runs every twenty seconds AND on every profile
    // you open, which is the one place a hitch is actually felt.
    for (const id in roster) {
        const v = roster[id];
        if (!v || folded.get(id) === v.guilds.length) continue;
        asMap.set(id, v.guilds);
    }
    if (!asMap.size) return;
    if (foldAnswers(asMap, me)) notifySweep();
}

/**
 * Someone whose profile you opened onto the roster.
 *
 * Recording their mutual friends is not enough on its own: the friend map is built by
 * walking the ROSTER, so a person who is not on it never appears however much we know
 * about them. That is the whole of "I looked at their profile, I can see the mutual, and
 * the list still doesn't have them" — the answer was there, the person wasn't.
 */
const onProfileOpened = (e: any) => {
    if (!active || !loaded) return;
    const id = profileUserId(e);
    if (!id || isMe(id)) return;
    let guilds: string[] = [];
    // Which of your servers they are in, so the row can say where they were found
    try { guilds = (GuildMemberStore as any).memberOf?.(id) ?? []; } catch { }
    if (addToRoster(roster, new Map([[id, Array.isArray(guilds) ? guilds : []]]), Date.now())) {
        scheduleRosterFlush();
    }
    // Mutuals may already hold the free answer from the same event; fold it in now
    // rather than waiting up to 20s for the next silent tick.
    setTimeout(() => { try { harvestRosterAnswers(); } catch { } }, 0);
};

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------
// PULL BEFORE PUSH, always. The server merges highest-wins, which is only correct
// because a machine's counters already include what every other machine contributed by
// the time it pushes. Reverse the order and the maximum silently discards whichever
// machine was used least.
const SYNC_TICK = 5 * 60 * 1000;
// A full pull is the server's single heaviest operation — it materialises the whole
// merged view, ~49MB of JSON, where a delta is ~15KB. It exists to heal drift, not to
// carry data, and the delta path is guarded hard enough to be trusted between healings:
// an unknown timestamp is always sent, a nonsense `since` falls back to a full pull, and
// the friend graph rides along complete every time. Hourly was spending the expensive
// operation ~24x more often than the thing it protects against ever happens.
const SYNC_FULL_EVERY = 24 * 60 * 60 * 1000;
let syncTimer: any = null;
let syncWatermark = 0;      // only advanced by a SUCCESSFUL push
// How far the last successful PULL got, in the server's clock. Separate from the push
// watermark above: they advance on different events, and conflating them would make a
// failed push silently skip a chunk of the incoming history.
let pullWatermark = 0;
// People this machine has stopped being able to prove anything about, waiting to be told
// to the server. Omitting them from a push cannot mean "delete": a blob can be shared by
// several accounts, so no single push is the complete set for it. Held until a push
// SUCCEEDS, so a failed sync does not swallow the retraction.
let retractedPending = new Set<string>();
let syncFullAt = 0;
let syncBusy = false;
let syncLast = "";          // shown in the modal so a silent failure is visible

/**
 * The watermarks, kept across restarts.
 *
 * They used to be plain module variables, so every Discord start reset them to 0 — and a
 * zero pull watermark means "send me everything", which on this pool is ~50MB the server
 * has to merge and serialise in one piece. That request fails often enough that the
 * watermark frequently never advanced at all, so the next tick asked for the whole thing
 * again: a loop that could only break by winning a coin flip, on a payload that grows
 * every day. Persisting them is what makes the incremental path the normal case.
 *
 * Scoped per account, like the profiles they are merged into. A watermark says "this
 * store already holds everything up to T" — true of the account it was recorded against
 * and nothing else, so sharing one across accounts would silently skip records for
 * whichever account did not do the pulling.
 */
const SYNC_KEY = "XicordDossierSync";
const syncKeyFor = (id: string | null) => (id ? `${SYNC_KEY}:${id}` : SYNC_KEY);

/** A stored watermark is only usable if it is a real past instant. */
function sane(v: any): number {
    const n = Number(v);
    // A value from the future would skip everything up to it, and there is no way for a
    // client to notice that hole afterwards — so anything implausible degrades to a full
    // pull, which is slow but cannot lose records.
    return Number.isFinite(n) && n > 0 && n <= Date.now() ? n : 0;
}

async function loadSyncState() {
    pullWatermark = 0; syncWatermark = 0; syncFullAt = 0;
    try {
        const s = await DataStore.get(syncKeyFor(accountId));
        if (s && typeof s === "object") {
            pullWatermark = sane((s as any).pull);
            syncWatermark = sane((s as any).push);
            syncFullAt = sane((s as any).fullAt);
        }
    } catch (e) { console.error("Xicord Dossier: sync state load failed", e); }
}

function saveSyncState() {
    // Captured up front: an account switch swaps both while the write is in flight, and
    // one account's watermarks must never land under another's key.
    const key = syncKeyFor(accountId);
    const state = { pull: pullWatermark, push: syncWatermark, fullAt: syncFullAt };
    void DataStore.set(key, state).catch(e => {
        console.error("Xicord Dossier: sync state save failed", e);
    });
}

/** Your own accounts: the current login plus any listed in settings. */
function myAccountIds(): string[] {
    const out = new Set<string>();
    const me = UserStore.getCurrentUser()?.id;
    if (me) out.add(me);
    for (const raw of String(settings.store.syncMyIds || "").split(/[,\s]+/)) {
        const id = raw.trim();
        if (/^\d{5,25}$/.test(id)) out.add(id);
    }
    return [...out];
}

/**
 * Read through Vencord's settings rather than importing Xicord Sync, so the two plugins
 * stay independent: the Dossier keeps syncing with this one disabled, it simply falls
 * back to the safe answer — the watchlist stays here.
 */
function syncShareWatchlist(): boolean {
    try {
        const p = Settings.plugins["Xicord Sync"];
        return p?.enabled === true && p?.shareWatchlist === true;
    } catch { return false; }
}

function syncConfig() {
    const url = String(settings.store.syncUrl || "").trim();
    const token = String(settings.store.syncToken || "").trim();
    return { url, token, on: !!settings.store.syncEnabled && !!url && !!token };
}

export function syncStatus() { return { last: syncLast, watermark: syncWatermark, busy: syncBusy }; }

// Routed through the Cache plugin's native module: the renderer cannot reach an
// arbitrary host through Discord's CSP, and the main process has no CSP at all.
// Looked up lazily, not at module scope: the plugin helpers may not exist yet when this
// module is evaluated, and touching `window` at import time breaks any environment that
// does not have one.
function syncNative(): any {
    try { return (globalThis as any).VencordNative?.pluginHelpers?.["Xicord Cache"] ?? null; }
    catch { return null; }
}

async function syncCall(base: string, token: string, path: string, body?: any): Promise<any> {
    const url = base.replace(/\/+$/, "") + path;
    const native = syncNative();
    if (!native?.syncRequest) throw new Error("sync needs the Xicord Cache plugin (desktop only)");
    const res = await native.syncRequest(url, token, body === undefined ? undefined : JSON.stringify(body));
    if (!res || res.status < 200 || res.status >= 300) {
        throw new Error(`${path} -> ${res?.status ?? "no response"}`);
    }
    return res.body;
}

async function syncOnce(full = false) {
    const { url, token, on } = syncConfig();
    if (!on || !loaded || syncBusy) return;
    syncBusy = true;
    const mine = myAccountIds();
    try {
        // ---- pull first ----
        // A full pull is ~49MB of JSON, almost none of which changes between two syncs.
        // `since` asks for only the records newer than the last successful pull; the
        // watermark is the SERVER's own clock, handed back to us, so a skewed client
        // cannot skip records. A `full` run drops it and re-reads everything, which is
        // what heals any drift.
        const poolPath = !full && pullWatermark > 0 ? `/v1/pool?since=${pullWatermark}` : "/v1/pool";
        const pool = await syncCall(url, token, poolPath);
        const added = fromPool(pool, profiles, mine, Date.now());
        // the other half of the shared graph: what everyone else's scanner proved
        const pooledChanged = fromPooledFriends(pool, pooledFriends, Date.now());
        // The voice timeline is owned by a different plugin, which persists it itself —
        // this connection is just the one it borrows. A disabled Voice Log answers 0.
        const voiceIn = (() => { try { return VoiceLogAPI.mergeVoice(pool?.voice); } catch { return 0; } })();
        const priv = await syncCall(url, token, "/v1/me");
        const changed = fromPrivate(priv, friendMap);
        if (added) { dirty = true; scheduleFlush(); trackedDirty = true; }
        if (changed) scheduleFriendsFlush();
        if (pooledChanged) schedulePooledFlush();
        // Advance ONLY once everything above has been folded in. Moving it earlier would
        // mean a throw between the fetch and the merge silently skipped that window, and
        // nothing would ever ask for those records again.
        if (typeof pool?.syncedAt === "number" && pool.syncedAt > 0) {
            pullWatermark = pool.syncedAt;
            // Persist as soon as the pull is banked, not at the end: the push below is a
            // separate failure, and losing this to it would send us back to a full pull.
            saveSyncState();
        }

        // ---- then push ----
        const since = full ? 0 : syncWatermark;
        // hand over the names we have resolved, so the shared view is readable
        const out = toPool(profiles, mine, since, knownUsers as any);
        // The Voice Log keeps its own watermark: its events are stamped when they were
        // OBSERVED, which is a different clock from the profile store's `updated`, and
        // sharing one would silently skip whichever of the two moved less.
        const voiceSince = full ? 0 : (() => { try { return VoiceLogAPI.pushedThrough(); } catch { return 0; } })();
        const voiceHigh = (() => { try { return VoiceLogAPI.highWater(); } catch { return 0; } })();
        try { out.voice = VoiceLogAPI.exportVoice(mine, voiceSince); } catch { out.voice = {}; }
        const nVoice = Object.keys(out.voice ?? {}).length;
        const nPeople = Object.keys(out.people).length, nCalls = Object.keys(out.calls).length;
        if (nPeople || nCalls || nVoice) {
            // One request for the lot exceeded the server's body limit and came back 413,
            // which failed the entire sync. Batches are each a valid payload, so a big
            // first sync goes up in pieces instead of not at all.
            const batches = chunkPool(out);
            for (let i = 0; i < batches.length; i++) {
                await syncCall(url, token, "/v1/pool", batches[i]);
                if (batches.length > 1) syncLast = `sending… ${i + 1}/${batches.length}`;
            }
        }
        // Calls and proven friendships are the whole of what syncs. The watchlist used to
        // ride along unconditionally, and it is the one field here that describes YOU
        // rather than the people being recorded — so it now only goes if Xicord Sync is
        // installed AND explicitly told to send it.
        const retracting = [...retractedPending];
        await syncCall(url, token, "/v1/me",
            toPrivate(friendMap, syncShareWatchlist() ? WatchAPI.list() : [], {}, retracting));
        // Cleared only now: if the push threw, these are still owed and go up next time.
        for (const id of retracting) retractedPending.delete(id);

        // Advance ONLY after everything landed, so a failed push is retried rather than
        // skipped — a hole in the middle of the history would never be noticed.
        syncWatermark = Date.now();
        // Stamped from the log as it was BEFORE the push, not from now: anything observed
        // while the request was in flight was not in it, and skipping past those would
        // lose them for good.
        if (voiceHigh > 0) { try { VoiceLogAPI.markPushed(voiceHigh); } catch { } }
        if (full) syncFullAt = Date.now();
        saveSyncState();
        syncLast = `${new Date().toLocaleTimeString()} — sent ${nCalls} pairs${nVoice ? ` and ${nVoice} timelines` : ""}, pulled ${added} new people${voiceIn ? ` and ${voiceIn} voice events` : ""}`;
        notifySweep();
    } catch (e: any) {
        syncLast = `${new Date().toLocaleTimeString()} — failed: ${e?.message ?? e}`;
        console.error("Xicord Dossier: sync failed", e);
    } finally { syncBusy = false; }
}

function syncTick() {
    if (!active) return;
    void syncOnce(Date.now() - syncFullAt > SYNC_FULL_EVERY);
}

/** Kicked from the modal, so a user can see it work rather than wait five minutes. */
export function syncNow() { void syncOnce(true); }

/** Roster progress, for the panel and the cache snapshot. */
export function rosterStats() {
    const perGuild: Record<string, number> = {};
    let scanned = 0;
    for (const [id, v] of Object.entries(roster)) {
        for (const g of v.guilds) perGuild[g] = (perGuild[g] ?? 0) + 1;
        try { if (MutualsAPI.isScanned(id)) scanned++; } catch { }
    }
    const total = Object.keys(roster).length;
    // Carry the pump's live cadence out to the dashboard too. Without it the only way to
    // ask "are we actually being rate-limited, or just slow?" is to eyeball the gaps
    // between scan timestamps and guess — and a guess is a bad basis for going faster.
    const pacing = (() => {
        try { return MutualsAPI.pacing?.() ?? null; } catch { return null; }
    })();
    return { total, scanned, pending: total - scanned, perGuild, pacing };
}

let harvestTimer: any = null;
/** Mutuals answers one person every 2.5s; batch those into one recompute. */
function scheduleHarvest() {
    if (harvestTimer != null) return;
    harvestTimer = setTimeout(() => { harvestTimer = null; harvestSweep(); }, 2000);
}

/**
 * How many servers' worth of each person has already been folded into the friend map.
 *
 * Both harvest paths used to re-derive their ENTIRE set on every pass. The sweep one runs
 * on every Mutuals answer (debounced to two seconds) against a set that stays populated
 * for the rest of the session, and the roster one runs every twenty seconds and on every
 * profile you open. At the 20 000 people this now sweeps, one pass costs ~11ms of
 * rebuilding, re-sorting and copying the whole friend map — so that was a dropped frame
 * every two seconds forever, plus a full rewrite of the map to IndexedDB every thirty
 * seconds, and both grow with the roster now that the caps are gone.
 *
 * A Mutuals answer never changes within a session — the cache is memory-only and an id is
 * fetched once — so an answer already folded in has nothing left to give. Keyed by SERVER
 * COUNT rather than merely present/absent: someone turning up in a second server is new
 * information the row has to gain, and a plain Set would have frozen their "seen in N
 * servers" at whatever it was the first time they answered.
 */
const folded = new Map<string, number>();

/**
 * The subset of `seen` still worth asking Mutuals about.
 *
 * Someone is skipped only if their answer AND every server they were found in are already
 * folded in. Never skipped for merely having been looked at: a person with no answer yet
 * has nothing recorded against them here, so they come back on every pass until Mutuals
 * gets to them — which is the whole reason a sweep converges at all.
 */
export function freshAnswers(
    seen: Map<string, string[]>,
    done: Map<string, number>
): Map<string, string[]> {
    const fresh = new Map<string, string[]>();
    for (const [id, guilds] of seen) {
        if (done.get(id) === guilds.length) continue;
        fresh.set(id, guilds);
    }
    return fresh;
}

/**
 * Fold newly-answered people into the friend map. Returns whether anything changed.
 * Shared by both harvest paths so they cannot drift on what counts as an answer.
 */
function foldAnswers(seen: Map<string, string[]>, me: string | null): boolean {
    const fresh = freshAnswers(seen, folded);
    if (!fresh.size) return false;
    const { rows, cleared } = buildFriendMap(fresh, mutualsOf, me);
    if (!rows.length && !cleared.length) return false;
    // Before the merge, which is what deletes them: a retraction is only owed for a claim
    // we actually made. Most people answer with no visible mutuals, so retracting every
    // one of them would have sent ~12 000 tombstones for findings that never existed.
    for (const id of cleared) if (friendMap[id]) retractedPending.add(id);
    friendMap = mergeFriendMap(friendMap, rows, Date.now(), MAX_FRIEND_MAP, cleared);
    // Only what actually landed. With a cap restored, mergeFriendMap can evict a row it
    // was just handed, and marking that one folded would retire it for the session.
    for (const r of rows) if (friendMap[r.id]) folded.set(r.id, fresh.get(r.id)!.length);
    // "Nobody" is an answer too, and on this pool it is the common one — leaving it
    // unrecorded would re-derive the majority of the set on every single pass.
    for (const id of cleared) folded.set(id, fresh.get(id)!.length);
    scheduleFriendsFlush();
    return true;
}

function harvestSweep() {
    if (!loaded || !sweepSeen.size) return;
    const me = UserStore.getCurrentUser()?.id ?? null;
    foldAnswers(sweepSeen, me);
    // Progress is read off what has been folded in by EITHER path. The background sweep
    // answers for the same people, and counting only this function's own work would leave
    // the button short of the finish line for the rest of the session.
    let scanned = 0;
    for (const id of sweepSeen.keys()) if (folded.has(id)) scanned++;
    const pending = sweepSeen.size - scanned;

    // Knowing when a run is OVER is not the same as "everyone answered": a rate-limited
    // lookup leaves the queue without ever answering, so some people can stay pending
    // forever. Nor can the queue length settle it — it is shared with the voice-state
    // scanner, which in a busy server keeps it permanently non-empty. So the signal is
    // our own progress: once nobody new has been answered for in a long while, whatever
    // is left is not coming, and the button must go back to offering a retry rather
    // than sitting on "Sweeping…" for the rest of the session.
    if (scanned > sweepScanned) { sweepScanned = scanned; lastSweepProgress = Date.now(); }
    if (sweeping && (!pending || Date.now() - lastSweepProgress > SWEEP_STALL)) sweeping = false;
    notifySweep();
}

function scheduleFriendsFlush() {
    friendsDirty = true;
    if (friendsTimer != null) return;
    friendsTimer = setTimeout(flushFriends, FLUSH_DELAY);
}

function flushFriends() {
    if (friendsTimer != null) { clearTimeout(friendsTimer); friendsTimer = null; }
    if (!friendsDirty || !loaded) return;
    friendsDirty = false;
    // Same care as flush(): capture key and object now, so an account switch mid-write
    // cannot land the outgoing account's findings under the incoming account's key.
    const key = friendsKeyFor(accountId);
    const writing = friendMap;
    void DataStore.set(key, writing).catch(e => {
        if (writing === friendMap) friendsDirty = true;
        console.error("Xicord Dossier: friend map save failed", e);
    });
}

// The profile store lives in IndexedDB, not settings.json. It runs to a megabyte once a
// few hundred people are tracked, and settings.json is rewritten in full for every
// unrelated setting change anywhere in Vencord — so keeping it there taxed the whole
// client. `loaded` gates recording: IndexedDB reads are async, and writing before the
// read lands would persist an empty store over the real one.
const PROFILES_KEY = "XicordDossierProfiles";
let loaded = false;

// The store is per-ACCOUNT. Everything here is observed from the point of view of
// whoever is logged in, so pooling several accounts into one store means a second
// account inherits thousands of strangers the first account met. Discord never cached
// those people for the new account, so their names cannot be resolved and they show up
// as "user 1a2b3c" — hundreds of them. Keyed by account, each login sees only its own.
let accountId: string | null = null;
const keyFor = (id: string | null) => (id ? `${PROFILES_KEY}:${id}` : PROFILES_KEY);

// Reading the stores is several IndexedDB round-trips, and an account switch can start
// a second read while the first is still in flight. Whichever finished last used to win
// the assignment — so a switch away and back could leave the OTHER account's profiles in
// memory under this account's id, and the next flush wrote them over the real store.
// A run that is no longer the newest now discards its results instead.
let loadSeq = 0;

async function load() {
    const seq = ++loadSeq;
    const stale = () => seq !== loadSeq;
    const acct = accountId = UserStore.getCurrentUser()?.id ?? null;
    const key = keyFor(acct);
    let data: any = null;
    try { data = await DataStore.get(key); } catch (e) { console.error("Xicord Dossier: load failed", e); }

    if (stale()) return;

    if (!data && acct) {
        // Adopt the older account-agnostic store into whoever is logged in now. That is
        // the best guess available — the records carry no account of their own — so it
        // happens once and the unscoped key is then removed.
        try {
            const unscoped = await DataStore.get(PROFILES_KEY);
            if (unscoped && typeof unscoped === "object" && Object.keys(unscoped).length) {
                await DataStore.set(key, unscoped);
                await DataStore.del(PROFILES_KEY);
                data = unscoped;
                console.log(`Xicord Dossier: assigned ${Object.keys(unscoped).length} existing profiles to this account`);
            }
        } catch (e) { console.error("Xicord Dossier: account migration failed", e); }
    }

    if (!data) {
        // One-time move of the old settings.json copy. The legacy field is only cleared
        // once the new home has the data, so an interrupted migration loses nothing.
        try {
            const legacy = JSON.parse(settings.store.profiles || "{}");
            if (legacy && typeof legacy === "object" && Object.keys(legacy).length) {
                await DataStore.set(key, legacy);
                data = legacy;
                settings.store.profiles = "";
                console.log(`Xicord Dossier: moved ${Object.keys(legacy).length} profiles out of settings.json`);
            }
        } catch (e) { console.error("Xicord Dossier: migration failed", e); }
    }

    if (stale()) return;
    profiles = data && typeof data === "object" ? data : {};

    // Previous sweeps' findings. Kept beside the profile store rather than inside it:
    // a sweep meets thousands of strangers, and folding them into `profiles` would let
    // them win the MAX_PROFILES eviction race against people you actually watch.
    let fd: any = null;
    try {
        fd = await DataStore.get(friendsKeyFor(acct));
    } catch (e) {
        console.error("Xicord Dossier: friend map load failed", e);
    }
    if (stale()) return;
    friendMap = fd && typeof fd === "object" ? fd : {};

    // Names, account-scoped and swapped on every switch. The old global blob is adopted
    // into whoever is logged in now on first run, then removed — the same one-time move
    // the profile store does above.
    try {
        let names = await DataStore.get(namesKeyFor(acct));
        if (!names && acct) {
            const unscoped = await DataStore.get(NAMES_KEY);
            if (unscoped && typeof unscoped === "object" && Object.keys(unscoped).length) {
                await DataStore.set(namesKeyFor(acct), unscoped);
                await DataStore.del(NAMES_KEY);
                names = unscoped;
            }
        }
        knownUsers = names && typeof names === "object" ? names : {};
    } catch (e) { console.error("Xicord Dossier: name cache load failed", e); knownUsers = {}; }
    if (stale()) return;
    // The pool's findings ARE the same for every account — kept shared on purpose — so
    // they load once and are never swapped out.
    if (!Object.keys(pooledFriends).length) {
        try {
            const p = await DataStore.get(POOLED_KEY);
            if (p && typeof p === "object") pooledFriends = p;
        } catch (e) { console.error("Xicord Dossier: pooled friends load failed", e); }
    }
    // Identity history rides along with the name cache: same account scope, same migration.
    try {
        let hist = await DataStore.get(identityKeyFor(acct));
        if (!hist && acct) {
            const unscoped = await DataStore.get(IDENTITY_KEY);
            if (unscoped && typeof unscoped === "object" && Object.keys(unscoped).length) {
                await DataStore.set(identityKeyFor(acct), unscoped);
                await DataStore.del(IDENTITY_KEY);
                hist = unscoped;
            }
        }
        identity = hist && typeof hist === "object" ? hist : {};
    } catch (e) { console.error("Xicord Dossier: identity history load failed", e); identity = {}; }

    if (stale()) return;
    try {
        const r = await DataStore.get(rosterKeyFor(accountId));
        roster = r && typeof r === "object" ? r : {};
    } catch (e) { console.error("Xicord Dossier: roster load failed", e); roster = {}; }

    if (stale()) return;
    // Last, and account-scoped: without this every start asks the server for the whole
    // pool, which is the request that keeps failing.
    await loadSyncState();

    loaded = true;
}

/** Bank whatever is open, then forget everything held for the outgoing account. */
function unloadAccount() {
    const now = Date.now();
    for (const [targetId, o] of open) {
        const p = profileFor(targetId);
        for (const [c, since] of o.companions) {
            const rec = p.companions[c] ?? (p.companions[c] = { count: 0, ms: 0, last: 0 });
            rec.ms += Math.max(0, now - since);
            rec.last = now;
        }
        p.updated = now;
    }
    for (const id of [...openGame.keys()]) closeGame(id, now);
    open.clear();
    dirty = true;
    flush(); // still keyed to the OLD account — see flush()
    flushFriends(); // ditto — see flushFriends()
    flushNames(); // names are per-account now; bank them before the swap clears them
    flushIdentity(); // ditto — a witnessed rename belongs to the account that saw it
    loaded = false;
    profiles = {};
    // Per-account now, so they are emptied on the way out and reloaded for the incoming
    // account. The pool cache is deliberately NOT cleared here — it is shared.
    knownUsers = {};
    identity = {};
    // Cleared with the profiles they describe. Carrying the outgoing account's watermark
    // into the incoming one would tell the server "I already have everything up to T"
    // about a store that holds none of it, and those records are never offered again.
    pullWatermark = 0; syncWatermark = 0; syncFullAt = 0;
    friendMap = {};
    friendsDirty = false;
    sweepSeen = new Map();
    // Cleared with the friend map it describes: it says "this person's answer is already
    // folded in there", which is false the moment the map is emptied for another account.
    folded.clear();
    roster = {};
    sweeping = false;
    notifySweep();
    tracked = new Set();
    trackedDirty = true;
    sweptGuilds.clear();
    stopResolving();
    unresolvable.clear();
}

/**
 * Discord fires this on login and on every account switch. Nothing used to watch it, so
 * swapping accounts silently kept recording the previous account's data — and mixing
 * two accounts' people into one store is what produced the wall of unnamed "user"
 * entries in the dashboard.
 */
const onConnectionOpen = () => {
    if (!active) return;
    const next = UserStore.getCurrentUser()?.id ?? null;
    if (next === accountId) return; // reconnect, not a switch
    console.log(`Xicord Dossier: account changed (${accountId ?? "none"} -> ${next ?? "none"}), swapping stores`);
    // Config first, while the fields still hold the OLD account's values: this banks them
    // and applies the incoming account's, firing the watcher plugins' own change listeners.
    try { swapAccountConfig(accountId, next); } catch (e) { console.error("Xicord Dossier: config swap failed", e); }
    unloadAccount();
    void load().then(() => {
        if (!active) return;
        trackedDirty = true;
        try { for (const id of trackedSet()) reconcile(id); } catch { }
    });
};
function scheduleFlush() {
    dirty = true;
    if (flushTimer != null) return;
    flushTimer = setTimeout(flush, FLUSH_DELAY);
}
function flush() {
    if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
    // Never write before the read has landed, or an empty store overwrites the real one
    if (!dirty || !loaded) return;
    // prune oversized companion maps (keep most-seen)
    for (const p of Object.values(profiles)) {
        const keys = Object.keys(p.companions);
        if (keys.length > MAX_COMPANIONS) {
            keys.sort((a, b) => p.companions[b].count - p.companions[a].count);
            for (const k of keys.slice(MAX_COMPANIONS)) delete p.companions[k];
        }
        if (p.games) {
            const gk = Object.keys(p.games);
            if (gk.length > MAX_GAMES) {
                gk.sort((a, b) => p.games![b].ms - p.games![a].ms);
                for (const k of gk.slice(MAX_GAMES)) delete p.games![k];
            }
        }
    }
    // drop the least-recently-updated propagated profiles, never a real target
    const ids = Object.keys(profiles);
    if (!uncapped(MAX_PROFILES) && ids.length > MAX_PROFILES) {
        const keep = new Set(WatchAPI.list());
        const rest = ids.filter(id => !keep.has(id))
            .sort((a, b) => (profiles[b]?.updated ?? 0) - (profiles[a]?.updated ?? 0));
        for (const id of rest.slice(Math.max(0, MAX_PROFILES - keep.size))) delete profiles[id];
        trackedDirty = true;
    }
    dirty = false;
    // Capture the key AND the object up front: an account switch replaces both while
    // this write is still in flight, and the outgoing account's data must not land
    // under the incoming account's key.
    const key = keyFor(accountId);
    const writing = profiles;
    // IndexedDB stores the object graph directly — no JSON.stringify of a megabyte on
    // the main thread, and nothing else in Vencord is rewritten alongside it.
    void DataStore.set(key, writing).catch(e => {
        if (writing === profiles) dirty = true; // let the next flush retry, if still ours
        console.error("Xicord Dossier: save failed", e);
    });
}

function profileFor(id: string): Profile {
    let p = profiles[id];
    if (!p) { p = profiles[id] = { companions: {}, guilds: {}, updated: 0, firstSeen: Date.now() }; }
    return p;
}

// Reconcile a target's open overlap against who is actually in their public VC now.
// The name of the game this person is currently playing, or null. Discord activity
// type 0 is "Playing"; a rich-presence game usually carries that too.
function currentGame(update: any): string | null {
    const acts = update?.activities;
    if (!Array.isArray(acts)) return null;
    const game = acts.find((a: any) => a && a.type === 0 && typeof a.name === "string" && a.name);
    return game ? game.name : null;
}

/** Fold an open game session's elapsed time into the profile. */
function closeGame(id: string, now: number) {
    const g = openGame.get(id);
    if (!g) return;
    openGame.delete(id);
    const p = profileFor(id);
    const games = p.games ?? (p.games = {});
    const rec = games[g.name] ?? (games[g.name] = { ms: 0, last: 0, sessions: 0 });
    rec.ms += Math.max(0, now - g.since);
    rec.last = now;
    p.updated = now;
    scheduleFlush();
}

/** Update a tracked person's game session from a presence update. */
function reconcileGame(id: string, update: any) {
    const now = Date.now();
    const name = currentGame(update);
    const cur = openGame.get(id);
    if (cur && cur.name === name) return; // still on the same game
    if (cur) closeGame(id, now); // stopped or switched — bank the old one
    if (name) {
        openGame.set(id, { name, since: now });
        const p = profileFor(id);
        const games = p.games ?? (p.games = {});
        const rec = games[name] ?? (games[name] = { ms: 0, last: 0, sessions: 0 });
        rec.sessions += 1;
        rec.last = now;
        p.updated = now;
        scheduleFlush();
    }
}

const onPresenceUpdates = (e: any) => {
    // same reason as onVoiceStateUpdates: never write before the store has loaded
    if (!active || !loaded) return;
    const track = trackedSet();
    if (track.size === 0) return;
    for (const update of e?.updates ?? []) {
        const id = update?.user?.id;
        if (id && track.has(id)) reconcileGame(id, update);
    }
};

/** One user's live voice state, or null. Wrapped so a store hiccup cannot break a render. */
function liveStateOf(userId: string): any {
    try { return VoiceStateStore.getVoiceStateForUser(userId); } catch { return null; }
}

/** Occupants of a voice channel, working even for locked/hidden channels. */
function channelOccupants(channelId: string, guildId?: string): Record<string, any> {
    // Primary path: the per-channel map. For a channel you can't view/join this can
    // come back empty even though you CAN see who's in it, so fall back to the
    // guild's full voice-state map filtered by channel.
    const direct = VoiceStateStore.getVoiceStatesForChannel(channelId);
    if (direct && Object.keys(direct).length) return direct;
    if (!guildId) return direct ?? {};
    const perGuild = ((VoiceStateStore.getAllVoiceStates() ?? {}) as Record<string, any>)[guildId] ?? {};
    const out: Record<string, any> = {};
    for (const uid in perGuild) if (perGuild[uid]?.channelId === channelId) out[uid] = perGuild[uid];
    return out;
}

/**
 * Where someone is RIGHT NOW, and who is in there with them — or null if they are not in
 * a voice channel at all.
 *
 * Deliberately not read from the dossier: that is a record of what has already happened,
 * and every figure in it is minutes to months old. This is the live store, so a row can
 * say "in a call now" and mean it. The lookups are injected so the logic can be tested
 * without Discord's stores.
 */
export function liveCall(
    id: string,
    stateOf: (userId: string) => any,
    occupantsOf: (channelId: string, guildId?: string) => Record<string, any>,
    meId?: string | null
): { channelId: string; guildId?: string; others: string[]; } | null {
    let vs: any = null;
    try { vs = stateOf(id); } catch { return null; }
    const channelId = vs?.channelId;
    if (!channelId) return null;
    const guildId = vs?.guildId;
    let others: string[] = [];
    try {
        const occ = occupantsOf(channelId, guildId) ?? {};
        // The subject is in their own channel, and so are you when you are sitting in it;
        // neither is news, and listing yourself reads as a bug.
        others = Object.keys(occ).filter(u => u && u !== id && u !== meId);
    } catch { }
    return { channelId, guildId, others };
}

/**
 * How present someone is right now. Three tiers, because they afford different things:
 * you can talk to a person in YOUR channel this second, a person in another channel is
 * reachable but not present, and a person out of voice entirely is neither.
 *
 * Being in a voice channel at all used to be the whole test, so anyone anywhere in voice
 * came out the same green as someone sitting next to you — which is the one state the
 * green is worth spending on.
 */
export type VoiceTier = "with-me" | "elsewhere" | "away";

export function voiceTier(
    live: { channelId: string; } | null | undefined,
    myChannelId: string | null | undefined
): VoiceTier {
    if (!live?.channelId) return "away";
    // No channel of my own means I am not in voice, so nobody can be in it with me
    return myChannelId && live.channelId === myChannelId ? "with-me" : "elsewhere";
}

/** The voice channel you are sitting in right now, or null. */
function myVoiceChannel(): string | null {
    try {
        const me = UserStore.getCurrentUser()?.id;
        return me ? (liveStateOf(me)?.channelId ?? null) : null;
    } catch { return null; }
}

function reconcile(targetId: string) {
    const me = UserStore.getCurrentUser()?.id;
    const vs = VoiceStateStore.getVoiceStateForUser(targetId);
    const channelId = vs?.channelId;
    const channel = channelId ? ChannelStore.getChannel(channelId) : null;
    // The voice state carries its own guildId; a locked/hidden channel is often not
    // in ChannelStore, so relying on the channel alone missed those calls entirely.
    const guildId = vs?.guildId ?? channel?.guild_id;
    const inPublic = !!(channelId && guildId); // guild VC only — no DMs/group calls
    const now = Date.now();
    const cur = open.get(targetId);

    const closeInto = (o: Open) => {
        const p = profileFor(targetId);
        for (const [c, since] of o.companions) {
            const rec = p.companions[c] ?? (p.companions[c] = { count: 0, ms: 0, last: 0 });
            rec.ms += Math.max(0, now - since);
            rec.last = now;
        }
        p.updated = now;
        scheduleFlush();
    };

    if (!inPublic) {
        if (cur) { closeInto(cur); open.delete(targetId); }
        return;
    }
    // moved channels: close the old overlap first
    if (cur && cur.channelId !== channelId) { closeInto(cur); open.delete(targetId); }

    let o = open.get(targetId);
    if (!o) { o = { channelId: channelId!, guildId: guildId!, companions: new Map() }; open.set(targetId, o); }

    const states = channelOccupants(channelId!, guildId);
    const occupants = new Set<string>();
    for (const uid of Object.keys(states)) {
        if (uid === targetId) continue;
        if (UserStore.getUser(uid)?.bot) continue;
        occupants.add(uid);
    }

    const p = profileFor(targetId);
    // new companions arriving
    for (const c of occupants) {
        if (!o.companions.has(c)) {
            o.companions.set(c, now);
            const rec = p.companions[c] ?? (p.companions[c] = { count: 0, ms: 0, last: 0 });
            const isNew = rec.count === 0;
            // A brand-new companion is a new edge, so the propagated set may now reach
            // further — but only ASK for a rebuild. Doing it here outright meant a full
            // breadth-first walk on every voice event in a busy group; see trackedSet().
            if (isNew) noteCallGraphGrew();
            rec.count += 1;
            rec.last = now;
            p.guilds[guildId!] = (p.guilds[guildId!] || 0) + 1;
            p.updated = now;
            if (isNew && settings.store.announceNew && c !== me) {
                const tn = UserStore.getUser(targetId)?.username ?? targetId;
                const cn = UserStore.getUser(c)?.username ?? c;
                Toasts.show({ message: `${tn} is calling with ${cn} (new)`, id: `xicord-dossier-${targetId}-${c}`, type: Toasts.Type.MESSAGE, options: { position: Toasts.Position.BOTTOM } });
            }
        }
    }
    // companions who left
    for (const [c, since] of [...o.companions]) {
        if (!occupants.has(c)) {
            const rec = p.companions[c] ?? (p.companions[c] = { count: 0, ms: 0, last: 0 });
            rec.ms += Math.max(0, now - since);
            rec.last = now;
            o.companions.delete(c);
        }
    }
    scheduleFlush();
}

const onVoiceStateUpdates = (e: any) => {
    // Recording before the store has loaded would build profiles on an empty graph,
    // which the load would then overwrite (see load()).
    if (!active || !loaded) return;
    const track = trackedSet();
    if (track.size === 0) return;
    const affected = new Set<string>(open.keys()); // recheck anyone with an open overlap
    for (const st of e?.voiceStates ?? []) {
        if (st?.userId && track.has(st.userId)) affected.add(st.userId);
    }
    for (const id of affected) if (track.has(id) || open.has(id)) reconcile(id);
};

/** Merge persisted totals with any currently-open overlap, for display/export. */
function viewProfile(targetId: string) {
    const p = profiles[targetId];
    const now = Date.now();
    const companions: Record<string, Companion> = {};
    if (p) for (const [c, rec] of Object.entries(p.companions)) companions[c] = { ...rec };
    const o = open.get(targetId);
    if (o) for (const [c, since] of o.companions) {
        const rec = companions[c] ?? (companions[c] = { count: 0, ms: 0, last: now });
        rec.ms += Math.max(0, now - since);
        rec.last = now;
    }
    // games, with any in-progress session's elapsed time merged in live
    const games: Record<string, GameStat> = {};
    if (p?.games) for (const [name, rec] of Object.entries(p.games)) games[name] = { ...rec };
    const og = openGame.get(targetId);
    if (og) {
        const rec = games[og.name] ?? (games[og.name] = { ms: 0, last: now, sessions: 0 });
        rec.ms += Math.max(0, now - og.since);
        rec.last = now;
    }
    return { companions, guilds: p?.guilds ?? {}, games, firstSeen: p?.firstSeen ?? 0, updated: p?.updated ?? 0 };
}

/**
 * Everyone worth showing a dossier for: real targets first, then anyone reached by
 * propagation who has actually accumulated companions, most-recent first.
 */
function dossierSubjects(): string[] {
    const targets = WatchAPI.list();
    const seen = new Set(targets);
    const others = Object.keys(profiles)
        .filter(id => !seen.has(id) && Object.keys(profiles[id]?.companions ?? {}).length > 0)
        .sort((a, b) => (profiles[b]?.updated ?? 0) - (profiles[a]?.updated ?? 0));
    return [...targets, ...others];
}

/** For Xicord Cache */
/**
 * The all-server sweep's findings, for Xicord Cache to put in the dashboard snapshot.
 * Export-only, like getDossiers(): it is derived from hours of paced lookups against
 * ONE account, so restoring it into another account would be a fabrication.
 */
export function getFriendMap(): Record<string, { friends: string[]; guilds: string[]; at: number; }> {
    const out: Record<string, { friends: string[]; guilds: string[]; at: number; }> = {};
    for (const r of storedFriendRows(friendMap)) {
        out[r.id] = { friends: r.friends, guilds: r.guilds, at: friendMap[r.id]?.at ?? 0 };
    }
    return out;
}

export function getDossiers() {
    const out: Record<string, any> = {};
    for (const id of dossierSubjects()) {
        const v = viewProfile(id);
        if (Object.keys(v.companions).length) out[id] = v;
    }
    return out;
}

// ---------------- UI ----------------
function fmtDur(ms: number) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 48 ? `${h}h ${m % 60}m` : `${Math.round(h / 24)}d`;
}
function timeAgo(at: number) {
    if (!at) return "—";
    const s = Math.floor((Date.now() - at) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}
// ---------------------------------------------------------------------------
// Username resolution
// ---------------------------------------------------------------------------
// Propagation surfaces people you have never interacted with, so UserStore has no
// record of them and every name/avatar would render as a raw snowflake. Fetch the
// missing ones in the background, throttled, and re-render as they land.

const RESOLVE_DELAY = 220;
const resolving = new Set<string>();
const unresolvable = new Set<string>();
const resolveListeners = new Set<() => void>();
let resolveQueue: string[] = [];
let resolvePump: object | null = null;

// ---------------------------------------------------------------------------
// Persistent name cache
// ---------------------------------------------------------------------------
// UserStore is memory-only and starts EMPTY every launch, and the cache snapshot builds
// its name map straight from it — so every name the resolver ever learned was thrown
// away on restart and the dashboard fell back to "user 1a2b3c" for thousands of people.
// Names are kept on disk here. Account-scoped like everything else: switching to another
// account gives it its own clean view rather than a name cache full of people the other
// account met. The shared pool still carries names between accounts, so this stays useful
// without being mixed.
const NAMES_KEY = "XicordResolvedUsers";
const namesKeyFor = (id: string | null) => (id ? `${NAMES_KEY}:${id}` : NAMES_KEY);
interface KnownUser { username: string; avatar: string; banner?: string; at: number; }
let knownUsers: Record<string, KnownUser> = {};

// ---------------------------------------------------------------------------
// Identity history
//
// The name cache already noticed when someone's username or avatar changed — it just
// overwrote the old one and threw it away. Keeping it instead is the whole feature:
// people change name and picture precisely to shed the history attached to them, and
// this is the only place that history survives.
//
// Account-scoped like the name cache it rides beside: this account keeps the identity
// changes it witnessed, and switching accounts does not pour one account's sightings into
// another's.
// ---------------------------------------------------------------------------
const IDENTITY_KEY = "XicordIdentityHistory";
const identityKeyFor = (id: string | null) => (id ? `${IDENTITY_KEY}:${id}` : IDENTITY_KEY);
interface IdentityEntry { username: string; avatar?: string; banner?: string; from: number; until: number; }
type IdentityHistory = Record<string, IdentityEntry[]>;
let identity: IdentityHistory = {};
let identityDirty = false;
let identityTimer: any = null;
// A person who edits their profile daily must not grow without bound, and 20 past looks
// is already far more than anyone needs to recognise someone.
const MAX_IDENTITY_PER_USER = 20;

/**
 * Bank the value that is being replaced. Returns whether anything was recorded.
 *
 * Only a real change counts: `rememberUser` is called on every resolve, so treating a
 * re-observation of the same name as history would fill the store with duplicates of
 * the present. An empty avatar is "we never saw one", not "they removed it", so it is
 * not worth a history entry on its own.
 */
export function recordIdentity(
    store: IdentityHistory,
    id: string,
    prev: { username: string; avatar?: string; banner?: string; at?: number; } | undefined,
    next: { username: string; avatar?: string; banner?: string; },
    now: number,
    cap = MAX_IDENTITY_PER_USER
): boolean {
    if (!id || !prev || !prev.username) return false;
    const nameChanged = prev.username !== next.username;
    const avatarChanged = !!prev.avatar && prev.avatar !== next.avatar;
    const bannerChanged = !!prev.banner && prev.banner !== next.banner;
    if (!nameChanged && !avatarChanged && !bannerChanged) return false;
    const list = store[id] ?? (store[id] = []);
    const last = list[list.length - 1];
    // the same old look twice running is one period, not two
    if (last && last.username === prev.username && last.avatar === prev.avatar && last.banner === prev.banner) {
        last.until = now;
        return true;
    }
    list.push({ username: prev.username, avatar: prev.avatar, banner: prev.banner, from: prev.at ?? now, until: now });
    if (list.length > cap) list.splice(0, list.length - cap);
    return true;
}

/** Everyone who has changed identity, most recently changed first. */
export function identityChanges(
    store: IdentityHistory,
    current: Record<string, { username: string; avatar?: string; }>,
    limit = 50
): Array<{ id: string; now: string; was: string[]; changedAt: number; changes: number; }> {
    const out: Array<{ id: string; now: string; was: string[]; changedAt: number; changes: number; }> = [];
    for (const [id, list] of Object.entries(store ?? {})) {
        if (!Array.isArray(list) || !list.length) continue;
        const names: string[] = [];
        for (let i = list.length - 1; i >= 0; i--) {
            const n = list[i]?.username;
            if (n && !names.includes(n)) names.push(n);
        }
        out.push({
            id, now: current?.[id]?.username ?? id, was: names,
            changedAt: list[list.length - 1]?.until ?? 0, changes: list.length
        });
    }
    return out.sort((a, b) => b.changedAt - a.changedAt).slice(0, limit);
}

/**
 * The avatar HASH out of whatever we hold — a full CDN URL, or an already-bare hash.
 *
 * The live stores keep the full `getAvatarURL()` string (change detection compares them
 * verbatim, so that stays), but the snapshot only needs the hash: the dashboard rebuilds
 * https://cdn.discordapp.com/avatars/{id}/{hash} itself. Idempotent, so re-exporting an
 * already-hashed value is safe, and "" for a default-avatar embed URL (no per-user hash).
 */
export function avatarHash(a?: string): string {
    if (!a) return "";
    if (!a.startsWith("http")) return a;            // already a bare hash
    const m = /\/avatars\/\d+\/([^./?]+)/.exec(a);   // only real per-user avatars, not embed/avatars/N.png
    return m ? m[1] : "";
}

/** The identity history, for the Xicord Cache snapshot. */
export function getIdentityHistory(): IdentityHistory {
    const out: IdentityHistory = {};
    // avatar -> hash on the way out; banner is left as-is (the dashboard never rebuilds it)
    for (const [id, list] of Object.entries(identity)) if (list?.length) out[id] = list.map(e => ({ ...e, avatar: avatarHash(e.avatar) }));
    return out;
}

function scheduleIdentityFlush() {
    identityDirty = true;
    if (identityTimer != null) return;
    identityTimer = setTimeout(flushIdentity, 15000);
}
function flushIdentity() {
    if (identityTimer != null) { clearTimeout(identityTimer); identityTimer = null; }
    if (!identityDirty || !loaded) return;
    identityDirty = false;
    // Capture key AND object up front: an account switch replaces both mid-write, and the
    // outgoing account's history must not land under the incoming account's key.
    const key = identityKeyFor(accountId);
    const writing = identity;
    void DataStore.set(key, writing).catch(e => {
        if (writing === identity) identityDirty = true;
        console.error("Xicord Dossier: identity history save failed", e);
    });
}
let namesDirty = false;
let namesTimer: any = null;

function scheduleNamesFlush() {
    namesDirty = true;
    if (namesTimer != null) return;
    namesTimer = setTimeout(flushNames, 15000);
}
function flushNames() {
    if (namesTimer != null) { clearTimeout(namesTimer); namesTimer = null; }
    if (!namesDirty || !loaded) return;
    namesDirty = false;
    const key = namesKeyFor(accountId);
    const writing = knownUsers;
    void DataStore.set(key, writing).catch(e => {
        if (writing === knownUsers) namesDirty = true;
        console.error("Xicord Dossier: name cache save failed", e);
    });
}
/** Record whatever Discord told us about this person, so it survives a restart. */
function rememberUser(u: any) {
    if (!u?.id || !u.username) return;
    const prev = knownUsers[u.id];
    const avatar = (() => { try { return u.getAvatarURL?.() ?? ""; } catch { return ""; } })();
    const banner = (() => { try { return u.getBannerURL?.({ size: 480 }) ?? u.banner ?? ""; } catch { return ""; } })();
    if (prev && prev.username === u.username && prev.avatar === avatar && (prev.banner ?? "") === banner) return;
    // Bank the outgoing look BEFORE overwriting it — this line is the whole of the
    // alias/avatar/banner history feature; everything else just reads it back.
    const now = Date.now();
    if (recordIdentity(identity, u.id, prev, { username: u.username, avatar, banner }, now)) {
        scheduleIdentityFlush();
    }
    knownUsers[u.id] = { username: u.username, avatar, banner, at: now };
    scheduleNamesFlush();
}

/** Names learned so far, for the Xicord Cache snapshot. */
export function getResolvedUsers(): Record<string, { username: string; avatar: string; }> {
    const out: Record<string, { username: string; avatar: string; }> = {};
    // hash, not URL — matches buildCache's live-user path, so both sources of the snapshot
    // agree and the dashboard's uavatar() only ever has one shape to rebuild
    for (const [id, u] of Object.entries(knownUsers)) out[id] = { username: u.username, avatar: avatarHash(u.avatar) };
    return out;
}
/** For the progress readout in the modal. */
export function nameCacheSize() { return Object.keys(knownUsers).length; }

function known(id: string) {
    const u = UserStore.getUser(id);
    if (u) { rememberUser(u); return true; }   // free to capture: no fetch involved
    return !!knownUsers[id];
}

/** Queue any of these we don't have yet. `first` jumps the queue (visible graph). */
function requestUsers(ids: string[], first = false) {
    const add: string[] = [];
    for (const id of ids) {
        if (!id || known(id) || resolving.has(id) || unresolvable.has(id)) continue;
        resolving.add(id);
        add.push(id);
    }
    if (!add.length) return;
    if (first) resolveQueue.unshift(...add); else resolveQueue.push(...add);
    startResolvePump();
}

// A failed lookup is not proof the account is gone. Rate limits, a network blip or a
// momentarily unavailable profile all throw the same way, and treating that as a verdict
// retired the person for the rest of the session — after a big sweep trips Discord's
// rate limiter, that condemns hundreds of perfectly real people to "Unknown". Only a
// definitive 404 / "Unknown User" is permanent; everything else is retried, and a 429
// pauses the whole pump instead of burning through the queue writing people off.
const MAX_RESOLVE_ATTEMPTS = 3;
const RATE_LIMIT_PAUSE = 30000;
const failedAttempts = new Map<string, number>();
let resolvePauseUntil = 0;
let sweepTimer: any = null;

function startResolvePump() {
    if (resolvePump != null || !active) return;
    const token = {};
    resolvePump = token;
    void (async () => {
        try {
            while (resolvePump === token) {
                // sit out a rate-limit pause rather than spending requests into it
                const waiting = resolvePauseUntil - Date.now();
                if (waiting > 0) {
                    await new Promise(r => setTimeout(r, Math.min(waiting, 5000)));
                    continue;
                }
                const id = resolveQueue.shift();
                if (id == null) return;

                let retry = false;
                try {
                    rememberUser(await UserUtils.getUser(id));
                    failedAttempts.delete(id);
                } catch (e: any) {
                    const status = e?.status ?? e?.response?.status;
                    const code = e?.body?.code ?? e?.code;
                    if (status === 404 || code === 10013) {
                        // Discord says there is no such user: that one IS permanent
                        unresolvable.add(id);
                        failedAttempts.delete(id);
                    } else {
                        if (status === 429) {
                            // retry_after is seconds; be generous, and never trust it blindly
                            const after = Number(e?.body?.retry_after ?? e?.retry_after ?? 0);
                            const ms = after > 0 ? Math.min(after * 1000, 120000) : RATE_LIMIT_PAUSE;
                            resolvePauseUntil = Date.now() + Math.max(2000, ms);
                        }
                        const n = (failedAttempts.get(id) ?? 0) + 1;
                        failedAttempts.set(id, n);
                        if (n >= MAX_RESOLVE_ATTEMPTS) { unresolvable.add(id); failedAttempts.delete(id); }
                        else retry = true;
                    }
                } finally {
                    if (!retry) resolving.delete(id);
                }
                if (resolvePump !== token) return;
                if (retry) resolveQueue.push(id); // back of the queue, still marked resolving
                resolveListeners.forEach(l => { try { l(); } catch { } });
                await new Promise(r => setTimeout(r, RESOLVE_DELAY));
            }
        } finally { if (resolvePump === token) resolvePump = null; }
    })();
}

function stopResolving() {
    resolvePump = null;
    resolveQueue = [];
    resolving.clear();
    failedAttempts.clear();
    resolvePauseUntil = 0;
}

/**
 * Queue everyone the dossier knows about for a name lookup, so the dashboard stops
 * showing "user 1a2b3c" for people it has plenty of data on. Anyone already named (live
 * or from the cache) is skipped, so repeat sweeps cost nothing, and the existing pump
 * paces the rest at one every RESOLVE_DELAY. Queued LAST so anything on screen still
 * jumps ahead of the backlog.
 */
function sweepNames() {
    if (!active || !loaded) return;
    const want = new Set<string>();
    for (const [id, p] of Object.entries(profiles)) {
        want.add(id);
        for (const c of Object.keys(p?.companions ?? {})) want.add(c);
    }
    requestUsers([...want]);
}

/** How much of the dossier still has no name, for the progress readout. */
export function nameSweepProgress() {
    const want = new Set<string>();
    for (const [id, p] of Object.entries(profiles)) {
        want.add(id);
        for (const c of Object.keys(p?.companions ?? {})) want.add(c);
    }
    let missing = 0;
    for (const id of want) if (!UserStore.getUser(id) && !knownUsers[id] && !unresolvable.has(id)) missing++;
    return { total: want.size, missing, queued: resolveQueue.length, unresolvable: unresolvable.size };
}

/** Re-render this component as queued usernames resolve, and ask for `ids`. */
function useResolvedUsers(ids: string[], first = false) {
    const [, force] = React.useReducer((x: number) => x + 1, 0);
    React.useEffect(() => {
        resolveListeners.add(force);
        return () => void resolveListeners.delete(force);
    }, []);
    const key = ids.join(",");
    React.useEffect(() => { requestUsers(ids, first); }, [key]);
}

function uname(id: string) {
    const u = UserStore.getUser(id);
    if (u) return u.username;
    // fall back to a name we resolved in an earlier session, before giving up on the id
    const k = knownUsers[id];
    if (k?.username) return k.username;
    // Still readable while it loads, and stays distinguishable if it never resolves
    return unresolvable.has(id) ? `Unknown (${String(id).slice(0, 6)}…)` : String(id);
}
function uavatar(id: string, size?: number) {
    // small sizes matter: a full graph can request a couple of hundred of these
    const live = UserStore.getUser(id)?.getAvatarURL?.(undefined, size);
    return live ?? knownUsers[id]?.avatar ?? IconUtils.getDefaultAvatarURL(id);
}
function initial(name: string) { return (String(name || "?").trim().charAt(0) || "?").toUpperCase(); }
function trunc(s: string, n: number) { s = String(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

// In-Discord ego network: the target at the centre, companions around it, line
// weight = shared calls, dot size = times seen together.
//
// Live force layout: drag any node and the rest respond through the springs and
// repulsion, drag the background to pan, double-click to reset, and the graph
// parts around the cursor as you move it.
//
// Positions are deliberately NOT in the JSX. React renders the structure once and
// the loop below writes cx/cy/x/y straight to the DOM, so a parent re-render can't
// stomp the live layout and we never re-render 20 nodes at 60fps.
const W = 600, H = 460, GCX = 300, GCY = 215, GR = 150;
// MAX_STEP is the furthest any node may travel in one frame — the layout's stability backstop.
const FIELD = 110, MAX_STEP = 40;

// `dim` draws someone as context rather than subject — used for the person you were
// looking at before you re-centred, so you keep your bearings without them competing
// with the new subject.
interface GNode { id: string; r: number; label: string; showLabel: boolean; fill: string; stroke: number; font: number; anchor?: boolean; avatar?: string; tip?: string; ringColour?: string; dim?: boolean; live?: VoiceTier; }

// Ring colour telling apart "they're actually friends" from "only ever seen in a call".
// Discord never exposes another account's friend list, so the only friendship we can
// prove for someone else is a MUTUAL one — a person who is friends with both you and
// them. Anyone they added who isn't also your friend is invisible to us and stays grey.
const RING_FRIEND = "var(--yellow-300, #f0b132)";
// Discord's own "in voice" green, so a live row reads the same as the voice indicators
// everywhere else in the client rather than inventing a private colour for it.
const RING_LIVE = "var(--green-360, #23a55a)";
const RING_CALL = "var(--background-primary)";
interface GLink { a: number; b: number; w: number; dim?: boolean; }

let graphSeq = 0;

/**
 * Where everyone ended up, kept per graph rather than per mounted component.
 *
 * A settled web is expensive to produce and instantly recognisable once it exists, so
 * throwing it away when the modal closes meant paying for it again — and watching it
 * re-settle — every single time. Keyed by subject, so walking between people and coming
 * back finds each web as you left it.
 */
const LAYOUT_CACHE = new Map<string, Map<string, { x: number; y: number; }>>();
const LAYOUT_CACHE_MAX = 12;

function layoutFor(key: string): Map<string, { x: number; y: number; }> {
    let m = LAYOUT_CACHE.get(key);
    if (!m) {
        m = new Map();
        // Bounded, and oldest-first: this holds two numbers per person drawn, so it is
        // small, but it must not grow for the rest of the session as you walk the graph.
        if (LAYOUT_CACHE.size >= LAYOUT_CACHE_MAX) {
            const oldest = LAYOUT_CACHE.keys().next().value;
            if (oldest !== undefined) LAYOUT_CACHE.delete(oldest);
        }
        LAYOUT_CACHE.set(key, m);
    }
    return m;
}

export type GraphKeyAction =
    | { kind: "move"; to: number; }
    | { kind: "open"; }
    | { kind: "recentre"; }
    | null;

/**
 * What a keypress means inside the network, as data rather than as side effects.
 *
 * Pulled out of the handler so the mapping can be tested without a browser: the graph is
 * an SVG driven by a physics simulation, and there is otherwise no way to check that
 * arrowing off the end wraps, or that Ctrl+C is still a copy rather than a re-centre.
 *
 * Returns null for a key that means nothing here, which the caller must leave alone —
 * swallowing unknown keys inside a modal breaks Escape and Tab.
 */
export function graphKeyAction(
    key: string,
    cursor: number,
    count: number,
    mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; } = {}
): GraphKeyAction {
    if (count <= 0) return null;
    // Wraps in both directions, so the end of the list is one press from the start
    // rather than a dead end.
    const at = (i: number) => ({ kind: "move" as const, to: ((i % count) + count) % count });
    switch (key) {
        case "ArrowRight": case "ArrowDown": return at(cursor + 1);
        case "ArrowLeft": case "ArrowUp": return at(cursor - 1);
        case "Home": return at(0);
        case "End": return at(count - 1);
        // what a double-click does with a pointer
        case "Enter": case " ": case "Spacebar": return { kind: "open" };
        // what a right-click does. Enter is already spoken for and a graph has no keyboard
        // convention for "context", so this is named in the on-screen instructions rather
        // than left to be guessed. Modified presses belong to the OS — Ctrl+C is a copy.
        case "c": case "C":
            return (mods.ctrl || mods.meta || mods.alt) ? null : { kind: "recentre" };
        default: return null;
    }
}

function ForceGraph({ spec, links, onOpen, onRecentre, height, spread = 1, layoutKey }: { spec: GNode[]; links: GLink[]; onOpen?: (id: string) => void; onRecentre?: (id: string) => void; height?: number; spread?: number; layoutKey?: string; }) {
    const svgRef = React.useRef<any>(null);
    const rootRef = React.useRef<any>(null);
    const apiRef = React.useRef<any>(null);
    const uidRef = React.useRef<string | null>(null);
    if (!uidRef.current) uidRef.current = `xdg${++graphSeq}`;
    const uid = uidRef.current;
    // Where everyone was standing, and how you had the view panned/zoomed, carried
    // across a restart of the simulation. New call data changes the cast, which restarts
    // the layout effect — without these the whole web was re-seeded from a fresh spiral
    // and your zoom snapped back to default, every time anyone was seen in a call.
    //
    // With a layoutKey the settled positions outlive the component too, so closing the
    // dossier and opening it again resumes the web instead of rebuilding it.
    const localPos = React.useRef<Map<string, { x: number; y: number; }>>(new Map());
    const posRef = layoutKey ? { current: layoutFor(layoutKey) } : localPos;
    const viewRef = React.useRef({ x: 0, y: 0, z: 1 });
    // reduce, not Math.max(...links): spreading an array passes one argument per
    // element, and a big interconnected web overruns the argument limit and throws
    const maxW = links.reduce((m, l) => (l.w > m ? l.w : m), 1);
    const HH = height ?? H;
    const GCY = HH / 2;
    // Restart the simulation only when the cast actually changes, not on every
    // parent re-render (viewProfile returns a fresh object each time).
    //
    // The edge count alone is NOT enough to identify the edge set. Edge pruning keeps
    // each person's strongest few links, so a single recorded call can swap which edge
    // is kept while leaving the count identical. React would then unmount one <line>
    // and mount another, but this effect — holding the only code that ever sets x1/y1/
    // x2/y2 — would not re-run, leaving the new line at the origin as a stray dot and
    // the physics still pulling on the detached old one. Hash the pairs as well.
    let linkSig = links.length;
    for (const l of links) linkSig = (Math.imul(linkSig, 31) + Math.imul(l.a, 7919) + l.b) | 0;
    const simKey = spec.map(n => n.id).join(",") + "#" + links.length + "#" + linkSig;

    // Rebuilding the layout MID-DRAG is what made grabbing someone look like the web
    // exploding: the effect tears down, the new closure has no `drag`, so the node stops
    // following the pointer, and the fresh simulation re-warms and reshuffles under your
    // finger. The modal re-renders every four seconds and sync changes the cast
    // constantly, so this happened on any drag that lasted a moment.
    //
    // The layout therefore keys off `liveKey`, which is held still for as long as a drag
    // is in progress and catches up the instant it ends.
    const draggingRef = React.useRef(false);
    const latestKey = React.useRef(simKey);
    latestKey.current = simKey;
    const [liveKey, setLiveKey] = React.useState(simKey);
    // Where the roving tabindex sits, and whether to DRAW the ring — two different
    // questions. Focus can arrive by mouse (Chromium focuses on mousedown), and conflating
    // them meant a node clicked with the pointer left the cursor unset, so the arrow keys
    // then did nothing at all. The position tracks any focus; only keyboard focus is drawn.
    const [focusIdx, setFocusIdx] = React.useState(-1);
    const [ringVisible, setRingVisible] = React.useState(false);
    const pendingFocus = React.useRef<number | null>(null);

    // Move the real DOM focus and pan the view to match, after React has rendered the new
    // tabIndex — an element with tabIndex -1 at the moment focus() is called is not
    // reliably focusable, so doing this inside the key handler drops focus out of the graph.
    React.useLayoutEffect(() => {
        const i = pendingFocus.current;
        if (i == null) return;
        pendingFocus.current = null;
        try { apiRef.current?.centreOn(i); } catch { }
        try { svgRef.current?.querySelector(`g[data-i="${i}"]`)?.focus?.({ preventScroll: true }); } catch { }
    }, [focusIdx]);
    React.useEffect(() => {
        if (draggingRef.current) return;          // deferred; applied on pointerup
        if (simKey !== liveKey) setLiveKey(simKey);
    }, [simKey, liveKey]);

    React.useLayoutEffect(() => {
        const svg = svgRef.current, root = rootRef.current;
        if (!svg || !root || !spec.length) return;

        const groups: any[] = Array.from(svg.querySelectorAll("g[data-i]"));
        const edges: any[] = Array.from(svg.querySelectorAll("line[data-i]"));
        // Bigger webs need shorter links or they sprawl straight off the canvas
        // Link length scales with the canvas area available per node, so a big web
        // fills the space instead of sprawling off it — but a SMALL graph must not
        // inherit the tight spacing a 300-node web needs, hence `spread`. Capped so
        // a sparse graph still fits inside the canvas.
        const fit = Math.min(W, HH) / 2 - 40;
        const base = Math.max(34, Math.min(fit, GR * spread, Math.sqrt((W * HH) / spec.length) * 0.62 * spread));
        // Beyond this the repulsion between a pair is ignored (see step()).
        const cut2 = (base * 2.6) ** 2;
        // More nodes means more outward push to balance, so the pull inward grows too.
        const centrePull = 0.006 * Math.max(1, Math.sqrt(spec.length) / 8);

        // Seeding every node on ONE ring means a 300-node graph starts as a solid
        // pile in the middle (measured: 1144 overlapping pairs on frame 1) that then
        // visibly explodes outward. A ring is right for a handful of nodes; beyond
        // that use a sunflower/phyllotaxis spiral, which covers the area evenly.
        const GOLDEN = Math.PI * (3 - Math.sqrt(5));
        const useRing = spec.length <= 24;
        // Elliptical, matching the canvas aspect — a circular spiral would waste the
        // extra height a big graph is given. sqrt() keeps the density even by area.
        const rx = W * 0.46, ry = HH * 0.46, last = Math.max(1, spec.length - 1);
        function seed(i: number) {
            if (spec[i].anchor) return { x: GCX, y: GCY };
            if (useRing) {
                const ang = -Math.PI / 2 + (i / Math.max(1, spec.length)) * 2 * Math.PI;
                return { x: GCX + base * Math.cos(ang), y: GCY + base * Math.sin(ang) };
            }
            const t = Math.sqrt(i / last), ang = i * GOLDEN;
            // Stretching a sunflower onto an ellipse distorts its even spacing, so a
            // few pairs land almost on top of each other. A deterministic jitter
            // (no Math.random, so a reset reproduces the same layout) breaks those up.
            const hash = (k: number) => (((Math.sin(k * 12.9898) * 43758.5453) % 1) + 1) % 1 - 0.5;
            const jit = Math.min(rx, ry) / Math.sqrt(last) * 0.7;
            return {
                x: GCX + rx * t * Math.cos(ang) + hash(i) * jit,
                y: GCY + ry * t * Math.sin(ang) + hash(i + 991) * jit
            };
        }

        // Neighbours by node index, so a newcomer can be dropped beside the person they
        // actually call with rather than at whatever spiral slot their index lands on.
        const nbr = new Map<number, Array<{ j: number; w: number; }>>();
        for (const l of links) {
            let la = nbr.get(l.a); if (!la) nbr.set(l.a, la = []);
            let lb = nbr.get(l.b); if (!lb) nbr.set(l.b, lb = []);
            la.push({ j: l.b, w: l.w });
            lb.push({ j: l.a, w: l.w });
        }
        const remembered = posRef.current;

        /** Where to drop someone we have never positioned before. */
        function seedNew(i: number) {
            let best: { x: number; y: number; } | null = null, bestW = -1;
            for (const { j, w } of nbr.get(i) ?? []) {
                const p = spec[j] && remembered.get(spec[j].id);
                if (p && w > bestW) { best = p; bestW = w; }
            }
            // Beside their strongest already-placed contact, on a deterministic bearing
            // so several newcomers of the same person don't stack on one spot.
            if (best) {
                const ang = i * GOLDEN;
                return { x: best.x + Math.cos(ang) * base * 0.6, y: best.y + Math.sin(ang) * base * 0.6 };
            }
            return seed(i);
        }

        let fresh = 0;
        const nodes = groups.map((g, i) => {
            const prev = remembered.get(spec[i].id);
            if (!prev) fresh++;
            const p0 = prev ?? seedNew(i);
            return {
                i, anchor: !!spec[i].anchor, r: spec[i].r, fresh: !prev,
                x: p0.x, y: p0.y,
                vx: 0, vy: 0, fixed: false, lastT: -1,
                dot: g.querySelector("circle.xd-dot"),
                glyph: g.querySelector("text.xd-glyph"),
                label: g.querySelector("text.xd-label"),
                hit: g.querySelector("circle.xd-hit"),
                clip: g.querySelector("circle.xd-clip"),
                img: g.querySelector("image.xd-img"),
                ring: g.querySelector("circle.xd-ring")
            };
        });
        // stronger bonds rest closer in, so the layout reads at a glance
        const bonds = links.map((l, i) => ({
            a: nodes[l.a], b: nodes[l.b], el: edges[i], dim: !!l.dim,
            rest: base * (0.55 + 0.45 * (1 - l.w / maxW))
        })).filter(b => b.a && b.b);

        // Mostly-familiar cast: slot the newcomers in, don't re-fling the whole web. A
        // wholesale change (switching to a different person's network) still gets a full
        // cold layout, because settling that from stale positions would look worse.
        //
        // The threshold used to be "no more than a quarter of the cast is new". Once the
        // recorder started finding people quickly that was crossed on nearly every
        // refresh, so the web went fully cold every few seconds and never stopped moving.
        // What actually matters is whether there is a settled web to preserve at all, so
        // the test is now on how much we DO remember.
        const known = nodes.length - fresh;
        const incremental = nodes.length > 0 && known >= Math.max(1, nodes.length * 0.5);
        // Only enough heat to let the newcomers settle. seedNew has already dropped them
        // beside their strongest contact, so they start close and need very little.
        const startAlpha = incremental ? Math.min(0.2, 0.04 + 0.02 * fresh) : 1;
        // And it has to COOL faster than the modal refreshes. At the shared 0.985 rate an
        // incremental restart took ~4s to reach the cutoff, against a 4s refresh — so the
        // next restart always arrived first and the layout was permanently warm. That is
        // what read as shaking: not one violent motion, but a settle that never finished.
        const decay = incremental ? 0.955 : 0.985;

        let alpha = startAlpha, raf = 0, running = false;
        let drag: any = null, panDrag: any = null;
        let { z } = viewRef.current;
        const pan = { x: viewRef.current.x, y: viewRef.current.y };
        const ZMIN = 0.35, ZMAX = 4;
        const applyView = () => {
            viewRef.current = { x: pan.x, y: pan.y, z }; // survive the next restart
            root.setAttribute("transform", `translate(${pan.x},${pan.y}) scale(${z})`);
        };
        /** Zoom about a point in viewBox space, so what is under it stays put. */
        function zoomTo(next: number, ax = W / 2, ay = HH / 2) {
            const clamped = Math.max(ZMIN, Math.min(ZMAX, next));
            if (clamped === z) return;
            // graph point currently under (ax,ay) must land there again afterwards
            const gx = (ax - pan.x) / z, gy = (ay - pan.y) / z;
            z = clamped;
            pan.x = ax - gx * z; pan.y = ay - gy * z;
            applyView();
        }
        const ptr = { x: 0, y: 0, on: false };
        let ptrMoved = false;

        const fieldAt = (n: any) => {
            if (!ptr.on) return 0;
            const d = Math.hypot(n.x - ptr.x, n.y - ptr.y);
            return d >= FIELD ? 0 : 1 - d / FIELD;
        };

        function step() {
            let i, j, a, b, dx, dy, d, ux, uy, f;
            for (const bond of bonds) { // springs along recorded co-calls
                a = bond.a; b = bond.b;
                dx = a.x - b.x; dy = a.y - b.y;
                d = Math.hypot(dx, dy) || 0.01; ux = dx / d; uy = dy / d;
                f = (d - bond.rest) * 0.045 * alpha;
                if (!a.fixed) { a.vx -= ux * f; a.vy -= uy * f; }
                if (!b.fixed) { b.vx += ux * f; b.vy += uy * f; }
            }
            for (i = 0; i < nodes.length; i++) { // repulsion + collision
                for (j = i + 1; j < nodes.length; j++) {
                    a = nodes[i]; b = nodes[j];
                    dx = b.x - a.x; dy = b.y - a.y;
                    const dd = dx * dx + dy * dy;
                    // A distant pair barely repels, but across hundreds of nodes those
                    // crumbs sum into a force that inflates the web off the canvas.
                    if (dd > cut2) continue;
                    d = Math.sqrt(dd) || 0.01;
                    ux = dx / d; uy = dy / d;
                    f = Math.min(2.2, 1800 / (d * d)) * alpha;
                    if (!a.fixed) { a.vx -= ux * f; a.vy -= uy * f; }
                    if (!b.fixed) { b.vx += ux * f; b.vy += uy * f; }
                    const minD = a.r + b.r + 14; // breathing room, not just non-overlap
                    if (d < minD) {
                        const push = (minD - d) * 0.5;
                        if (!a.fixed) { a.x -= ux * push; a.y -= uy * push; }
                        if (!b.fixed) { b.x += ux * push; b.y += uy * push; }
                    }
                }
            }
            for (i = 0; i < nodes.length; i++) { // keep the web near the middle
                a = nodes[i]; if (a.fixed) continue;
                const k = (a.anchor ? 0.02 : centrePull) * alpha;
                a.vx += (GCX - a.x) * k; a.vy += (GCY - a.y) * k;
            }
            // (The cursor no longer physically pushes nodes — that made them dodge
            // the pointer and was the main reason they were hard to grab. The hover
            // swell/brighten is purely visual now, in draw().)
            let fastest = 0;
            for (i = 0; i < nodes.length; i++) { // integrate
                a = nodes[i];
                if (a.fixed) { a.vx = 0; a.vy = 0; continue; }
                a.vx *= 0.86; a.vy *= 0.86;
                // A node wired to a great many others sums that many spring forces each
                // frame, which feeds back and runs away — measured at coordinates in the
                // billions, with the entire web flung off the canvas. Damping alone does
                // not catch it, so cap the distance any node may travel per frame. No
                // topology can throw the layout to infinity once this holds.
                const sp2 = a.vx * a.vx + a.vy * a.vy;
                if (sp2 > MAX_STEP * MAX_STEP) { const k = MAX_STEP / Math.sqrt(sp2); a.vx *= k; a.vy *= k; }
                a.x += a.vx; a.y += a.vy;
                const sp = Math.abs(a.vx) + Math.abs(a.vy);
                if (sp > fastest) fastest = sp;
            }
            return fastest;
        }

        function draw() {
            for (const bond of bonds) {
                if (!bond.el) continue;
                bond.el.setAttribute("x1", bond.a.x); bond.el.setAttribute("y1", bond.a.y);
                bond.el.setAttribute("x2", bond.b.x); bond.el.setAttribute("y2", bond.b.y);
                // brighten a link when the cursor is near either end; a dimmed link
                // belongs to the person you were previously centred on
                const t = Math.max(fieldAt(bond.a), fieldAt(bond.b));
                bond.el.setAttribute("stroke-opacity", ((0.3 + 0.55 * t) * (bond.dim ? 0.3 : 1)).toFixed(3));
            }
            for (const n of nodes) {
                const t = fieldAt(n);
                if (t !== n.lastT) {
                    n.lastT = t;
                    const rr = n.r * (1 + 0.3 * t);
                    n.dot?.setAttribute("r", rr.toFixed(2));
                    n.ring?.setAttribute("r", rr.toFixed(2));
                    n.clip?.setAttribute("r", rr.toFixed(2));
                    n.img?.setAttribute("width", (rr * 2).toFixed(2));
                    n.img?.setAttribute("height", (rr * 2).toFixed(2));
                    // grow the invisible hit target too, so a node nudged aside by the
                    // cursor stays grabbable instead of dodging the pointer
                    n.hit?.setAttribute("r", (Math.max(n.r, 16) * (1 + 0.9 * t)).toFixed(2));
                }
                const cr = n.r * (1 + 0.3 * t);
                n.ring?.setAttribute("cx", n.x); n.ring?.setAttribute("cy", n.y);
                n.clip?.setAttribute("cx", n.x); n.clip?.setAttribute("cy", n.y);
                n.img?.setAttribute("x", (n.x - cr).toFixed(2)); n.img?.setAttribute("y", (n.y - cr).toFixed(2));
                n.dot?.setAttribute("cx", n.x); n.dot?.setAttribute("cy", n.y);
                n.glyph?.setAttribute("x", n.x); n.glyph?.setAttribute("y", n.y + (n.anchor ? 6 : 3.5));
                n.hit?.setAttribute("cx", n.x); n.hit?.setAttribute("cy", n.y);
                if (!n.label) continue;
                if (n.anchor) { n.label.setAttribute("x", n.x); n.label.setAttribute("y", n.y + n.r + 20); continue; }
                // push the label outward, away from the middle of the web
                const ang = Math.atan2(n.y - GCY, n.x - GCX), co = Math.cos(ang);
                n.label.setAttribute("x", n.x + (n.r + 10) * co);
                n.label.setAttribute("y", n.y + (n.r + 10) * Math.sin(ang) + 3);
                n.label.setAttribute("text-anchor", co > 0.2 ? "start" : co < -0.2 ? "end" : "middle");
            }
            drawPill();
        }

        // Hover pill: whoever the cursor is actually over, drawn in screen space so
        // it stays the same size no matter how far you have zoomed in.
        const pill = svg.querySelector("g.xd-pill");
        const pillBox = pill?.querySelector("rect");
        const pillName = pill?.querySelector("text.xd-pill-name");
        const pillSub = pill?.querySelector("text.xd-pill-sub");
        function drawPill() {
            if (!pill) return;
            let hovered: any = null;
            if (ptr.on && !drag) {
                let best = Infinity;
                for (const n of nodes) {
                    const d = Math.hypot(n.x - ptr.x, n.y - ptr.y);
                    const reach = Number(n.hit?.getAttribute("r")) || n.r;
                    if (d <= reach && d < best) { best = d; hovered = n; }
                }
            }
            if (!hovered) { pill.setAttribute("opacity", "0"); return; }
            const meta = spec[hovered.i];
            const name = meta.label, sub = meta.tip ?? "";
            // no text metrics in SVG without a reflow, so approximate the width
            const wpx = Math.max(name.length * 7.4, sub.length * 6.4) + 20;
            const hpx = sub ? 38 : 24;
            // node position in screen space, then clamped inside the canvas
            const sx = pan.x + hovered.x * z, sy = pan.y + hovered.y * z;
            const rr = (Number(hovered.dot?.getAttribute("r")) || hovered.r) * z;
            let px = sx - wpx / 2, py = sy - rr - hpx - 8;
            if (py < 4) py = sy + rr + 8;
            px = Math.max(4, Math.min(W - wpx - 4, px));
            pill.setAttribute("opacity", "1");
            pill.setAttribute("transform", `translate(${px.toFixed(1)},${py.toFixed(1)})`);
            pillBox?.setAttribute("width", wpx.toFixed(1));
            pillBox?.setAttribute("height", String(hpx));
            if (pillName) { pillName.setAttribute("x", String(wpx / 2)); pillName.textContent = name; }
            if (pillSub) { pillSub.setAttribute("x", String(wpx / 2)); pillSub.textContent = sub; }
        }

        function frame() {
            if (drag) alpha = Math.max(alpha, 0.3);
            // Only run physics while something is actually settling or being dragged.
            // Merely hovering no longer reheats the sim, so once it settles the nodes
            // hold still and are easy to grab — but we KEEP redrawing while the pointer
            // is over the graph so the hover pill and swell stay live.
            const physics = drag || alpha > 0.008;
            const speed = physics ? step() : 0;
            draw();
            ptrMoved = false;
            if (drag || speed > 0.05 || alpha > 0.008 || ptr.on) {
                if (physics) alpha *= decay;
                raf = requestAnimationFrame(frame);
            } else {
                running = false;
                // Settled. Bank it here rather than only on teardown: this is the layout
                // worth keeping, and it is the state a newcomer should be slotted into.
                remember();
            }
        }
        /** Snapshot the current positions into the layout cache. */
        function remember() {
            for (const n of nodes) {
                if (Number.isFinite(n.x) && Number.isFinite(n.y)) {
                    posRef.current.set(spec[n.i].id, { x: n.x, y: n.y });
                }
            }
        }
        function reheat(a: number) { alpha = Math.max(alpha, a); if (!running) { running = true; raf = requestAnimationFrame(frame); } }
        // Keep the redraw loop alive (for the hover pill) WITHOUT reheating physics.
        function ensureLoop() { if (!running) { running = true; raf = requestAnimationFrame(frame); } }

        // client px -> viewBox units (width:100% + fixed viewBox = uniform scale)
        const raw = (ev: any) => {
            const b = svg.getBoundingClientRect(), k = W / (b.width || W);
            return { x: (ev.clientX - b.left) * k, y: (ev.clientY - b.top) * k };
        };
        const local = (ev: any) => { const p = raw(ev); return { x: (p.x - pan.x) / z, y: (p.y - pan.y) / z }; };

        const onDown = (ev: any) => {
            // Left button (or touch) only. Right-click must NOT start a drag, or its
            // pointerup would open the profile on top of the re-centre in onCtx.
            if (ev.button > 0) return;
            const idx = ev.currentTarget?.getAttribute?.("data-hit");
            ev.preventDefault(); ev.stopPropagation();
            const n = nodes[Number(idx)];
            if (!n) return;
            drag = { n }; n.fixed = true;
            draggingRef.current = true;   // freeze rebuilds until this drag ends
            svg.style.cursor = "grabbing";
            try { svg.setPointerCapture(ev.pointerId); } catch { }
            reheat(0.9);
        };
        // Right-click re-centres the view on that person; left-click/tap still opens
        // their Discord profile, so neither gesture loses its old meaning.
        const onCtx = (ev: any) => {
            const idx2 = ev.currentTarget?.getAttribute?.("data-hit");
            const n = nodes[Number(idx2)];
            if (!n || !onRecentre) return;
            ev.preventDefault(); ev.stopPropagation();
            onRecentre(spec[n.i].id);
        };
        const onBgDown = (ev: any) => {
            if (ev.button > 0) return; // left/touch only; right-click stays a re-centre/context gesture
            ev.preventDefault();
            // Forgiving grab: if the press lands near a node (not just dead-on its hit
            // circle), grab that node rather than starting a pan. Makes small nodes and
            // near-misses easy to pick up.
            const lp = local(ev);
            let best: any = null, bestD = Infinity;
            for (const n of nodes) {
                const d = Math.hypot(n.x - lp.x, n.y - lp.y);
                const reach = Math.max(n.r + 12, 20);
                if (d <= reach && d < bestD) { bestD = d; best = n; }
            }
            if (best) {
                drag = { n: best }; best.fixed = true;
                svg.style.cursor = "grabbing";
                try { svg.setPointerCapture(ev.pointerId); } catch { }
                reheat(0.5);
                return;
            }
            const p = raw(ev);
            panDrag = { sx: p.x, sy: p.y, ox: pan.x, oy: pan.y };
            svg.style.cursor = "grabbing";
            try { svg.setPointerCapture(ev.pointerId); } catch { }
        };
        const onMove = (ev: any) => {
            const p = local(ev);
            if (p.x !== ptr.x || p.y !== ptr.y) ptrMoved = true;
            ptr.x = p.x; ptr.y = p.y; ptr.on = true;
            if (drag) { drag.n.x = p.x; drag.n.y = p.y; drag.n.vx = 0; drag.n.vy = 0; reheat(0.5); }
            else if (panDrag) {
                const q = raw(ev);
                pan.x = panDrag.ox + (q.x - panDrag.sx); pan.y = panDrag.oy + (q.y - panDrag.sy);
                applyView();
            } else ensureLoop(); // hover: redraw for the pill, but don't disturb the layout
        };
        const onUp = (ev: any) => {
            // Left-click only grabs/moves now — opening the profile moved to
            // double-click, so a plain click never navigates away by accident.
            if (drag) { drag.n.fixed = false; drag = null; reheat(0.45); }
            // Unfreeze rebuilds and take whatever the data did while the pointer was
            // down. This MUST run on every pointerup, not only when a drag was active —
            // leaving the flag set would freeze the layout for the rest of the session.
            if (draggingRef.current) {
                draggingRef.current = false;
                if (latestKey.current !== liveKey) setLiveKey(latestKey.current);
            }
            panDrag = null;
            svg.style.cursor = "grab";
            if (ev?.pointerType === "touch") { ptr.on = false; reheat(0.4); }
            try { svg.releasePointerCapture(ev.pointerId); } catch { }
        };
        // Double-click (or double-tap) a node opens their Discord profile.
        const onNodeDbl = (ev: any) => {
            const idx = ev.currentTarget?.getAttribute?.("data-hit");
            const n = nodes[Number(idx)];
            if (!n) return;
            ev.preventDefault(); ev.stopPropagation(); // don't also reset the view
            onOpen?.(spec[n.i].id);
        };
        const onEnter = () => { ptr.on = true; };
        const onLeave = () => { if (drag || panDrag) return; ptr.on = false; reheat(0.4); };
        const onWheel = (ev: any) => {
            ev.preventDefault();
            const p = raw(ev);
            zoomTo(z * (ev.deltaY < 0 ? 1.12 : 1 / 1.12), p.x, p.y);
        };
        const onReset = () => {
            // an explicit reset is the one place that DOES discard the remembered
            // layout — otherwise it would restore itself on the next data update
            remembered.clear();
            pan.x = 0; pan.y = 0; z = 1; applyView();
            nodes.forEach((n, i) => {
                const p0 = seed(i);
                n.x = p0.x; n.y = p0.y; n.vx = 0; n.vy = 0;
            });
            reheat(1);
        };

        const bg = svg.querySelector("rect.xd-bg");
        nodes.forEach((n, i) => {
            n.hit?.setAttribute("data-hit", String(i));
            n.hit?.addEventListener("pointerdown", onDown);
            n.hit?.addEventListener("contextmenu", onCtx);
            n.hit?.addEventListener("dblclick", onNodeDbl);
        });
        bg?.addEventListener("pointerdown", onBgDown);
        bg?.addEventListener("dblclick", onReset);
        svg.addEventListener("pointermove", onMove);
        svg.addEventListener("pointerup", onUp);
        svg.addEventListener("pointercancel", onUp);
        svg.addEventListener("pointerenter", onEnter);
        svg.addEventListener("pointerleave", onLeave);
        svg.addEventListener("wheel", onWheel, { passive: false });

        // let the zoom buttons outside the SVG drive the same view
        apiRef.current = {
            zoomBy: (f: number) => zoomTo(z * f),
            reset: onReset,
            get level() { return z; },
            /**
             * Bring one node to the middle of the canvas.
             *
             * Keyboard focus moving to a node that is scrolled off the canvas would be
             * focus you cannot see — the failure that makes most "keyboard accessible"
             * graphs unusable in practice. Arrowing between nodes pans the view to follow,
             * so the focused node is always the one being looked at.
             */
            centreOn: (i: number) => {
                const n = nodes[i];
                if (!n) return;
                pan.x = W / 2 - n.x * z;
                pan.y = HH / 2 - n.y * z;
                applyView();
            }
        };

        // Pre-warm: a few collision-only passes so the FIRST painted frame is already
        // free of overlaps, instead of opening as a clump that visibly separates.
        // On an incremental update only the newcomers are allowed to move, so the
        // arrangement you are already reading does not shift under you.
        const mayMove = (n: any) => !n.anchor && (!incremental || n.fresh);
        for (let w = 0; w < 12; w++) {
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const a = nodes[i], b = nodes[j];
                    if (incremental && !a.fresh && !b.fresh) continue;
                    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01;
                    const minD = a.r + b.r + 14;
                    if (d < minD) {
                        const ux = dx / d, uy = dy / d, push = (minD - d) * 0.5;
                        if (mayMove(a)) { a.x -= ux * push; a.y -= uy * push; }
                        if (mayMove(b)) { b.x += ux * push; b.y += uy * push; }
                    }
                }
            }
        }
        applyView();
        draw();
        reheat(startAlpha);

        return () => {
            // Remember where everyone ended up. This runs immediately before the effect
            // re-runs for new data, so the next layout starts from here rather than from
            // a cold spiral. (The frame loop also banks it the moment it settles, so a
            // teardown mid-motion cannot lose an already-relaxed web.)
            remember();
            cancelAnimationFrame(raf); running = false;
            apiRef.current = null;
            nodes.forEach(n => {
                n.hit?.removeEventListener("pointerdown", onDown);
                n.hit?.removeEventListener("contextmenu", onCtx);
                n.hit?.removeEventListener("dblclick", onNodeDbl);
            });
            bg?.removeEventListener("pointerdown", onBgDown);
            bg?.removeEventListener("dblclick", onReset);
            svg.removeEventListener("pointermove", onMove);
            svg.removeEventListener("pointerup", onUp);
            svg.removeEventListener("pointercancel", onUp);
            svg.removeEventListener("pointerenter", onEnter);
            svg.removeEventListener("pointerleave", onLeave);
            svg.removeEventListener("wheel", onWheel);
        };
    }, [liveKey]);

    if (!spec.length) return null;

    // whoever the view is centred on, for the diagram's description
    const anchorLabel = spec.find(n => n.anchor)?.label ?? "";

    /**
     * Where keyboard focus is, as an index into `spec`.
     *
     * A roving tabindex, not one tab stop per node: a thousand nodes each in the tab order
     * would mean a thousand presses to get past the graph. Exactly one node is tabbable at
     * a time, Tab moves past the whole graph, and the arrow keys move between people.
     *
     * -1 means "nothing here has focus"; the first node is the one that accepts the initial
     * Tab, so entering the graph always lands somewhere sensible.
     */
    const cursor = focusIdx < 0 ? 0 : Math.min(focusIdx, spec.length - 1);
    const focusNode = (i: number) => {
        const next = ((i % spec.length) + spec.length) % spec.length;   // wraps both ways
        setFocusIdx(next);
        setRingVisible(true);   // arriving here by key is keyboard use by definition
        // Focus follows in a layout effect rather than here, because the element only
        // becomes tabbable once React has painted the new tabIndex.
        pendingFocus.current = next;
    };
    const onGraphKey = (e: React.KeyboardEvent) => {
        if (focusIdx < 0) return;
        const act = graphKeyAction(e.key, cursor, spec.length,
            { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey });
        if (!act) return;
        e.preventDefault();
        const id = spec[cursor]?.id;
        if (act.kind === "move") focusNode(act.to);
        else if (act.kind === "open" && id) onOpen?.(id);
        else if (act.kind === "recentre" && id) onRecentre?.(id);
    };

    return (
        <>
            <Flex style={{ gap: "6px", alignItems: "center", marginBottom: "6px" }}>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY}
                    onClick={() => apiRef.current?.zoomBy(1 / 1.3)}>−</Button>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY}
                    onClick={() => apiRef.current?.zoomBy(1.3)}>+</Button>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY}
                    onClick={() => apiRef.current?.reset()}>Reset view</Button>
                <Forms.FormText style={{ opacity: 0.5, fontSize: 12 }}>
                    scroll to zoom · drag a node to move it · drag the background to pan
                    {" · "}<b>keyboard:</b> tab into the web, arrows to move, Enter opens, C centres
                </Forms.FormText>
            </Flex>
            {/*
              * A group of buttons, one per person, rather than one opaque picture.
              *
              * The nodes are positioned by a running simulation, so they have no inherent
              * document order to tab through — but `spec` is ordered best-connected first,
              * which is a more useful order than their scattered positions would give
              * anyway. That ordering is what the arrow keys walk.
              */}
            <svg ref={svgRef} viewBox={`0 0 ${W} ${HH}`} width="100%"
                role="group"
                aria-label={`Network of ${spec.length} ${spec.length === 1 ? "person" : "people"}`
                    + `${anchorLabel ? `, centred on ${anchorLabel}` : ""}`
                    + ", ordered best-connected first. Arrow keys move between people,"
                    + " Enter opens a profile, C centres the view on someone."}
                onKeyDown={onGraphKey}
                // focusout bubbles, so this fires when focus leaves the graph entirely;
                // moving between two nodes keeps `relatedTarget` inside it.
                onBlur={(e: any) => {
                    if (!e.currentTarget?.contains?.(e.relatedTarget)) { setFocusIdx(-1); setRingVisible(false); }
                }}
                style={{ maxHeight: HH, display: "block", touchAction: "none", userSelect: "none", cursor: "grab" }}>
                <rect className="xd-bg" x={0} y={0} width={W} height={HH} fill="transparent" />
                <g ref={rootRef}>
                    {links.map((l, i) => (
                        <line key={`e${l.a}-${l.b}`} data-i={i} stroke="var(--brand-500)"
                            strokeWidth={1 + 4 * (l.w / maxW)} strokeOpacity={0.3} strokeLinecap="round" />
                    ))}
                    {spec.map((n, i) => (
                        // Two independent fades. `dim` = context from the person you were
                        // centred on before; still fully interactive, so you can
                        // right-click back to them. `live` = how present they are right
                        // now: someone out of voice sits back at 0.7 so the people
                        // actually in a channel stand out without a colour of their own.
                        <g key={n.id} data-i={i} opacity={(n.dim ? 0.3 : 1) * (n.live === "away" ? 0.7 : 1)}
                            role="button"
                            // Exactly one node is in the tab order at a time — see focusNode().
                            tabIndex={i === cursor ? 0 : -1}
                            // The rings and fading are colour alone, so what they mean is
                            // said out loud here instead.
                            aria-label={`${n.label}`
                                + (n.anchor ? " — the person this view is centred on" : "")
                                + (n.live === "with-me" ? " — in this call with you"
                                    : n.live === "elsewhere" ? " — in a voice channel" : "")
                                + (n.dim ? " — where you came from" : "")}
                            // The cursor follows focus however it arrived, so arrowing works
                            // straight after clicking a node. Only the RING is keyboard-only:
                            // Chromium focuses on mousedown too, so drawing it unconditionally
                            // would leave a marker behind after every click and drag. If the
                            // browser cannot answer, draw it — a stray ring beats losing the cue.
                            onFocus={(e: any) => {
                                setFocusIdx(i);
                                let keyboard = true;
                                try { keyboard = e.currentTarget.matches(":focus-visible"); } catch { }
                                setRingVisible(keyboard);
                            }}
                            style={{ outline: "none" }}>
                            {/* the disc and initial show through if the avatar fails to load */}
                            <circle className="xd-dot" fill={n.fill} r={n.r} />
                            <text className="xd-glyph" textAnchor="middle" fontSize={n.font} fontWeight={n.anchor ? 800 : 700} fill="#fff">
                                {initial(n.label)}
                            </text>
                            {n.avatar && (
                                <>
                                    {/* the clip circle lives INSIDE the node group: the sim finds it
                                        with g.querySelector, and a clipPath renders nothing itself */}
                                    <clipPath id={`${uid}-c${i}`}>
                                        <circle className="xd-clip" r={n.r} cx={0} cy={0} />
                                    </clipPath>
                                    <image className="xd-img" href={n.avatar} xlinkHref={n.avatar}
                                        clipPath={`url(#${uid}-c${i})`} width={n.r * 2} height={n.r * 2}
                                        preserveAspectRatio="xMidYMid slice" />
                                </>
                            )}
                            {/*
                              * Keyboard focus is shown by restyling THIS ring rather than by
                              * adding a circle of its own. The simulation positions each shape
                              * individually — it sets cx/cy per frame and never transforms the
                              * group — so a newly added circle has no position at all and sits
                              * at the graph's origin, a marker floating in empty space nowhere
                              * near the person it is meant to point at. This ring is already
                              * moved every frame, so it cannot drift. The sim only writes
                              * r/cx/cy, which leaves the stroke free.
                              */}
                            <circle className="xd-ring" r={n.r} fill="none"
                                stroke={i === focusIdx && ringVisible
                                    ? "var(--text-normal, #fff)"
                                    : (n.ringColour ?? (n.anchor ? "var(--brand-500)" : RING_CALL))}
                                strokeWidth={i === focusIdx && ringVisible ? Math.max(3, n.stroke + 1) : n.stroke}
                                strokeDasharray={i === focusIdx && ringVisible ? "4 3" : undefined} />
                            {n.showLabel && (
                                <text className="xd-label" textAnchor={n.anchor ? "middle" : undefined}
                                    fontSize={n.anchor ? 12 : 11} fontWeight={n.anchor ? 700 : undefined} fill="var(--text-normal)">
                                    {trunc(n.label, n.anchor ? 20 : 16)}
                                </text>
                            )}
                            <circle className="xd-hit" fill="transparent" style={{ cursor: "grab" }} />
                        </g>
                    ))}
                </g>
                {/* drawn outside the panned/zoomed group so it keeps a constant size */}
                <g className="xd-pill" opacity={0} style={{ pointerEvents: "none" }}>
                    <rect rx={7} ry={7} width={120} height={38} fill="var(--background-floating, #111214)"
                        stroke="var(--background-modifier-accent, #ffffff1a)" strokeWidth={1} />
                    <text className="xd-pill-name" y={16} textAnchor="middle" fontSize={12} fontWeight={700} fill="var(--text-normal)" />
                    <text className="xd-pill-sub" y={30} textAnchor="middle" fontSize={11} fill="var(--text-muted, #b5bac1)" />
                </g>
            </svg>
        </>
    );
}

/** One person at the centre, their call companions around them. */
/** The 20 people someone shares the most calls with, strongest first. */
function topCompanions(v?: ReturnType<typeof viewProfile> | null) {
    if (!v) return [];
    return Object.entries(v.companions)
        .map(([id, c]) => ({ id, count: c.count, ms: c.ms }))
        .sort((a, b) => b.count - a.count || b.ms - a.ms).slice(0, 20);
}

/**
 * One person at the centre, their call companions around them.
 *
 * Right-clicking anyone re-centres on them, and whoever you came FROM stays on screen
 * greyed out, along with their own companions. That keeps the thread of where you have
 * walked visible instead of the web appearing to change into something unrelated.
 */
function NetworkGraph({ targetId, view, ghostId, ghostView, onRecentre }: {
    targetId: string;
    view: ReturnType<typeof viewProfile>;
    ghostId?: string;
    ghostView?: ReturnType<typeof viewProfile> | null;
    onRecentre?: (id: string) => void;
}) {
    const comps = topCompanions(view);
    const ghosting = !!ghostId && ghostId !== targetId;
    const ghostComps = ghosting ? topCompanions(ghostView) : [];
    const maxCount = Math.max(...comps.map(c => c.count), 1);
    const ghostMax = Math.max(...ghostComps.map(c => c.count), 1);

    const everyone = [targetId, ...comps.map(c => c.id),
        ...(ghosting ? [ghostId!] : []), ...ghostComps.map(c => c.id)];
    useResolvedUsers(everyone, true);
    // Mutual friends of the target = people we can PROVE they added, because they
    // are friends with you too. Anything else is unknowable from the client.
    // Every hook must run before the early return below, or a target whose companion
    // count crosses zero changes the hook count between renders and React throws.
    React.useEffect(() => { scanForMutuals(everyone); },
        [targetId, ghostId, comps.length, ghostComps.length]);

    // The SUBJECT is what makes a graph. Re-centring onto someone with nothing recorded
    // used to leave the previous person's faded web on screen with a lone dot beside it,
    // which reads as "here is their network" when it is nothing of the sort. Draw
    // nothing instead, and let the caller say why.
    if (!comps.length) return null;

    // Live scan first, then whatever the all-server sweep banked — the Mutuals cache is
    // memory-only, so without the fallback every restart drops all the gold rings until
    // the scanner has crawled back to this person at one fetch every 2.5s.
    let friends: Set<string> | null = null;
    try { friends = provenFriends(targetId); } catch { }

    // One entry per person: the new subject and the old one usually share companions,
    // and the old subject is typically a companion of the new one. First writer wins,
    // and the live cast is written first, so nobody real is drawn as a ghost.
    const at = new Map<string, number>();
    const spec: GNode[] = [];
    const put = (n: GNode) => {
        const seen = at.get(n.id);
        if (seen !== undefined) return seen;
        at.set(n.id, spec.length);
        spec.push(n);
        return spec.length - 1;
    };

    const myChannel = myVoiceChannel();
    for (const c of comps) {
        const isFriend = friends?.has(c.id) ?? false;
        const r = 8 + 9 * Math.sqrt(c.count / maxCount);
        const tier = voiceTier(liveStateOf(c.id), myChannel);
        put({
            // no persistent label — the name shows in the hover pill instead
            id: c.id, label: uname(c.id), showLabel: false,
            r, fill: "var(--green-360)", stroke: 2, font: Math.min(12, r),
            avatar: uavatar(c.id, 64),
            // the green ring is reserved for people in the channel YOU are in; a
            // proven friendship keeps the gold otherwise
            ringColour: tier === "with-me" ? RING_LIVE : isFriend ? RING_FRIEND : RING_CALL,
            live: tier,
            tip: `${fmtDur(c.ms)} in call · ${c.count}× together · ${isFriend ? "friends" : "call only"}`
                + (tier === "with-me" ? " · in here with you now" : tier === "elsewhere" ? " · in another call now" : "")
        });
    }
    const totalMs = comps.reduce((a, c) => a + c.ms, 0);
    const anchorAt = put({
        id: targetId, label: uname(targetId), showLabel: false, r: 24, fill: "var(--brand-500)",
        stroke: 3, font: 18, anchor: true, avatar: uavatar(targetId, 128),
        tip: `${fmtDur(totalMs)} recorded with ${comps.length} ${comps.length === 1 ? "person" : "people"}`
    });

    let ghostAt = -1;
    if (ghosting && ghostComps.length) {
        ghostAt = put({
            id: ghostId!, label: uname(ghostId!), showLabel: false, r: 17,
            fill: "var(--brand-500)", stroke: 2, font: 13, dim: true,
            avatar: uavatar(ghostId!, 128),
            tip: `${uname(ghostId!)} — where you came from · right-click to go back`
        });
        for (const c of ghostComps) {
            const r = 6 + 6 * Math.sqrt(c.count / ghostMax);
            put({
                id: c.id, label: uname(c.id), showLabel: false,
                r, fill: "var(--green-360)", stroke: 2, font: Math.min(11, r),
                avatar: uavatar(c.id, 64), ringColour: RING_CALL, dim: true,
                tip: `${fmtDur(c.ms)} with ${uname(ghostId!)} · ${c.count}× together`
            });
        }
    }

    // Dedupe by unordered pair: the two networks overlap, and a repeated pair would
    // double-draw an edge and desync the positional edge/link pairing in ForceGraph.
    const links: GLink[] = [];
    const drawn = new Set<string>();
    const link = (a: number, b: number, w: number, dim?: boolean) => {
        if (a < 0 || b < 0 || a === b) return;
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (drawn.has(k)) return;
        drawn.add(k);
        links.push({ a, b, w, dim });
    };
    for (const c of comps) link(at.get(c.id)!, anchorAt, c.count);
    for (const c of ghostComps) link(at.get(c.id)!, ghostAt, c.count, true);

    // one person's network is small, so give it the full ring rather than the tight
    // spacing the hundreds-of-nodes view needs
    // keyed on the subject (and whoever is ghosted behind them), so walking to someone
    // and back finds their web settled rather than rebuilding it
    return <ForceGraph spec={spec} links={links} spread={2.1} layoutKey={`one:${targetId}`}
        onOpen={id => { if (id !== targetId) openUserProfile(id); }}
        onRecentre={onRecentre} />;
}

/**
 * Everyone at once: every person with a dossier, plus their companions, wired to
 * each other by recorded co-calls. Capped by connection strength so the biggest
 * webs stay legible and the O(n^2) repulsion pass stays cheap.
 */
const FULL_GRAPH_NODES = 150;
const MIN_GRAPH_NODES = 10;
const MAX_GRAPH_NODES = 1000;
// How many rows the "Calls with" list draws. Named because the live-call lookup below is
// batched over exactly this many companions, and the two must not drift apart — computing
// live state for rows that are never drawn is the cost this cap exists to avoid.
const COMPANIONS_SHOWN = 60;
// The node cap bounds how many people are drawn, but NOT how many lines: in a group
// where everyone knows everyone the edge count grows with the SQUARE of the group
// size, so 1000 people in tight friend groups is a quarter of a million edges. That
// is a solid block of colour rather than a readable web, it makes the per-frame
// spring pass crawl, and it used to blow the argument limit outright. Keep each
// person's strongest few links instead — that is linear in the node count, and it
// preserves the thing the graph is for: who each person is actually closest to.
const MAX_LINKS_PER_NODE = 6;

// You are in every call you join, so you end up recorded as a companion of nearly
// everyone. In the everyone-view that turns your own account into a hub wired to the
// whole cast, which both drowns out the real structure and hands the force layout one
// node with hundreds of springs on it — it visibly explodes outward. You already know
// who you call with, so leave yourself out of the web entirely. Nothing is deleted:
// this is a display filter, and the one-person view still shows you as a companion.
function isMe(id: string): boolean {
    try { return id === UserStore.getCurrentUser()?.id; } catch { return false; }
}

/** How many distinct people have any recorded co-call at all (excluding you). */
function totalKnownPeople(): number {
    const seen = new Set<string>();
    for (const [id, p] of Object.entries(profiles)) {
        if (isMe(id)) continue;
        const comps = Object.keys(p?.companions ?? {}).filter(c => !isMe(c));
        if (!comps.length) continue;
        seen.add(id);
        for (const c of comps) seen.add(c);
    }
    return seen.size;
}

/**
 * Thin a web down to each person's strongest `per` connections. A link survives if
 * EITHER end rates it that highly, which means a star — one busy person surrounded by
 * companions who know nobody else — comes through untouched, since each companion's
 * only link is their own top one. The edges that go are the ones BOTH ends consider
 * minor, and those are exactly the mush inside an everyone-knows-everyone group.
 *
 * Runs unconditionally. An earlier version skipped the pass whenever the total edge
 * count looked modest, but that measured the whole graph: one dense 41-person clique
 * sitting among sparser people slipped under the total and kept every one of its 820
 * edges, and adding a single person to that group tipped it over and made hundreds of
 * lines disappear at once.
 */
function pruneLinks(links: GLink[], per = MAX_LINKS_PER_NODE): GLink[] {
    if (links.length <= per) return links;
    const byNode = new Map<number, number[]>();
    links.forEach((l, i) => {
        for (const n of [l.a, l.b]) {
            const arr = byNode.get(n);
            if (arr) arr.push(i); else byNode.set(n, [i]);
        }
    });
    const keep = new Set<number>();
    for (const arr of byNode.values()) {
        // only the top `per` need to be in order, but these lists are short enough
        // (edges touching one node) that a plain sort is not worth avoiding
        arr.sort((x, y) => links[y].w - links[x].w);
        for (let i = 0; i < Math.min(per, arr.length); i++) keep.add(arr[i]);
    }
    return [...keep].sort((a, b) => a - b).map(i => links[i]);
}

function buildFullGraph(limit = FULL_GRAPH_NODES) {
    const pairW = new Map<string, number>();
    const pairMs = new Map<string, number>();
    const strength = new Map<string, number>();
    const msTotal = new Map<string, number>();
    for (const [id, p] of Object.entries(profiles)) {
        if (isMe(id)) continue;
        for (const [c, rec] of Object.entries(p?.companions ?? {})) {
            const n = rec?.count ?? 0;
            if (!n || c === id || isMe(c)) continue;
            const key = id < c ? `${id}|${c}` : `${c}|${id}`;
            // both people may hold a record of the same pairing; keep the stronger
            pairW.set(key, Math.max(pairW.get(key) ?? 0, n));
            pairMs.set(key, Math.max(pairMs.get(key) ?? 0, rec?.ms ?? 0));
            strength.set(id, (strength.get(id) ?? 0) + n);
            strength.set(c, (strength.get(c) ?? 0) + n);
        }
    }
    // per-person call time, counted once per pairing rather than once per record
    for (const [key, ms] of pairMs) {
        const [x, y] = key.split("|");
        msTotal.set(x, (msTotal.get(x) ?? 0) + ms);
        msTotal.set(y, (msTotal.get(y) ?? 0) + ms);
    }
    const ids = [...strength.keys()].sort((a, b) => (strength.get(b) ?? 0) - (strength.get(a) ?? 0)).slice(0, limit);
    const idx = new Map(ids.map((id, i) => [id, i]));
    const all: GLink[] = [];
    for (const [key, w] of pairW) {
        const [x, y] = key.split("|");
        const a = idx.get(x), b = idx.get(y);
        if (a === undefined || b === undefined) continue;
        all.push({ a, b, w });
    }
    // `strength` above is deliberately measured across EVERY edge, so dropping weak
    // lines below never changes how big or how central anyone is drawn — it only
    // thins what is painted.
    return { ids, links: pruneLinks(all), strength, msTotal };
}

/** Open the standalone dashboard in the user's real browser (smooth, out of Discord). */
/** `full` opens straight into the dashboard's full-screen everyone-view. */
function openDashboard(full = false) {
    const base = (settings.store.dashboardUrl || "http://localhost:8787").trim().replace(/#.*$/, "");
    const url = full ? `${base}#full` : base;
    try { (window as any).VencordNative?.native?.openExternal(url); }
    catch { try { window.open(url, "_blank"); } catch { } }
}

function FullGraph() {
    const limit = Math.max(MIN_GRAPH_NODES, Math.min(MAX_GRAPH_NODES, Number(settings.store.fullGraphNodes) || FULL_GRAPH_NODES));
    const { ids, links, strength, msTotal } = buildFullGraph(limit);
    const [renderHere, setRenderHere] = React.useState(false);
    useResolvedUsers(ids, true);
    if (!ids.length) return null;

    const n = ids.length;

    // A big animated web bogs Discord's renderer down; hand it to the dashboard,
    // which draws the same data in the browser smoothly. The user can still force it.
    const heavy = Math.max(20, Number(settings.store.heavyGraphNodes) || 90);
    if (n > heavy && !renderHere) {
        return (
            <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "12px", flexDirection: "column", gap: "8px", alignItems: "flex-start" }}>
                <Forms.FormTitle tag="h5" style={{ margin: 0 }}>{n} people — that's heavy to animate in Discord</Forms.FormTitle>
                <Forms.FormText style={{ opacity: 0.7, fontSize: 13 }}>
                    Rendering this many animated nodes inside Discord causes the lag you noticed.
                    The standalone dashboard draws the exact same network in your browser, where it
                    stays smooth. It reads your live data automatically — just open it.
                </Forms.FormText>
                <Flex style={{ gap: "8px" }}>
                    {/* this button exists because the web IS the full dossier here, so
                        land the user straight in the full-screen everyone-view */}
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND}
                        onClick={() => openDashboard(true)}>Open full dossier in dashboard</Button>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} look={Button.Looks.LINK}
                        onClick={() => setRenderHere(true)}>Render here anyway (may lag)</Button>
                </Flex>
                <Forms.FormText style={{ opacity: 0.5, fontSize: 12 }}>
                    Start the dashboard with <b>start.bat</b> first. Lower "Full dossier — max people",
                    or raise the heavy-graph threshold in this plugin's settings, to change when this appears.
                </Forms.FormText>
            </Flex>
        );
    }
    // Give a crowded web more canvas, and shrink the dots so they still fit.
    const height = Math.round(Math.max(H, Math.min(1100, 300 + n * 3.4)));
    const scale = Math.max(0.45, Math.min(1, 8 / Math.sqrt(n)));

    const maxS = Math.max(...ids.map(id => strength.get(id) ?? 0), 1);
    const myChannel = myVoiceChannel();
    const spec: GNode[] = ids.map((id, i) => {
        const s = (strength.get(id) ?? 0) / maxS;
        const target = WatchAPI.has(id);
        let friend = false;
        try { friend = !!(RelationshipStore as any).isFriend?.(id); } catch { }
        const r = (7 + 12 * Math.sqrt(s)) * scale;
        // liveStateOf, not liveCall: the graph only needs WHICH channel, and liveCall
        // additionally enumerates every occupant — a per-node cost across up to a
        // thousand nodes, for a list nothing here reads.
        const tier = voiceTier(liveStateOf(id), myChannel);
        return {
            id, label: uname(id),
            showLabel: false, // name shows on hover only
            r,
            fill: target ? "var(--brand-500)" : "var(--green-360)",
            stroke: target ? 3 : 2,
            font: Math.min(12, r),
            avatar: uavatar(id, 64),
            // in the everyone-view there is no single subject, so the useful split is
            // people YOU have added versus people you have only ever seen in calls —
            // except for anyone in your own channel, which outranks both
            ringColour: tier === "with-me" ? RING_LIVE
                : friend ? RING_FRIEND : target ? "var(--brand-500)" : RING_CALL,
            live: tier,
            tip: `${fmtDur(msTotal.get(id) ?? 0)} in call · ${strength.get(id) ?? 0} shared calls · ${friend ? "your friend" : "call only"}`
                + (tier === "with-me" ? " · in here with you now" : tier === "elsewhere" ? " · in another call now" : "")
        };
    });
    // one everyone-view, so one cache entry — the expensive layout to keep
    return <ForceGraph spec={spec} links={links} onOpen={openUserProfile} height={height} layoutKey="full" />;
}

/**
 * The one-person picker's search. Most of the dossier is people propagation dragged
 * in, so "show me the ones I actually chose to watch" was a question the box could not
 * answer — no name contains the word. Typing `watched` (or `targets`) lists your
 * Target-trait people instead of searching for the literal string; `all` lists
 * everyone. A keyword list is allowed to be longer than a name search, because asking
 * for it is asking for the whole list.
 */
export function pickerMatches(
    query: string,
    ids: string[],
    nameOf: (id: string) => string,
    isTarget: (id: string) => boolean,
    limit = 60,
    keywordLimit = 300
): { ids: string[]; keyword: "watched" | "all" | null; matched: number; } {
    const q = query.trim().toLowerCase();
    if (!q) return { ids: [], keyword: null, matched: 0 };

    let keyword: "watched" | "all" | null = null;
    let hits: string[];
    if (q === "watched" || q === "watching" || q === "target" || q === "targets") {
        keyword = "watched";
        hits = ids.filter(isTarget);
    } else if (q === "all" || q === "*" || q === "everyone") {
        keyword = "all";
        hits = [...ids];
    } else {
        hits = ids.filter(id => nameOf(id).toLowerCase().includes(q) || id.toLowerCase().includes(q));
    }
    return { ids: hits.slice(0, keyword ? keywordLimit : limit), keyword, matched: hits.length };
}

/**
 * Everyone across every server who can be PROVEN to have added someone, with who they
 * added and where they were found. Driven by the Mutuals scanner, which is paced at one
 * person every 2.5s — so this is a background run measured in hours, not a click.
 */
/**
 * The friend map drawn as a network — your friends as hubs, everyone proven to have added
 * them orbiting. Gold throughout, because every edge here is a proven friendship; the
 * dossier's graph draws call history, which is a different claim entirely.
 */
export function FriendGraph({ rows, onOpen }: { rows: FriendRow[]; onOpen: (id: string) => void; }) {
    const limit = Math.max(MIN_GRAPH_NODES, Math.min(MAX_GRAPH_NODES, Number(settings.store.fullGraphNodes) || FULL_GRAPH_NODES));
    // Three passes over every row plus a sort. `rows` is filtered upstream per keystroke, so
    // without this the graph was rebuilt — and, because the rebuild changes `simKey`, its
    // physics restarted from scratch — on every character typed into the filter.
    const g = React.useMemo(() => buildFriendGraph(rows, limit), [rows, limit]);
    useResolvedUsers([...g.hubs, ...g.people], true);
    if (!g.edges.length) return null;

    const at = new Map<string, number>();
    const spec: GNode[] = [];
    const put = (n: GNode) => {
        const seen = at.get(n.id);
        if (seen !== undefined) return seen;
        at.set(n.id, spec.length);
        spec.push(n);
        return spec.length - 1;
    };
    const addedBy = new Map<string, number>();
    for (const [, f] of g.edges) addedBy.set(f, (addedBy.get(f) ?? 0) + 1);
    // reduce, not Math.max(...) — same reason ForceGraph does: spreading passes one
    // argument per element, and a wide sweep has thousands of hubs
    let maxHub = 1;
    for (const n of addedBy.values()) if (n > maxHub) maxHub = n;
    // Indexed once. This used to be rows.find() inside the loop below, which is fine at
    // 150 nodes and quadratic at 1000 against a map of thousands — the exact combination
    // "Max people" is there to allow.
    const byId = new Map(rows.map(r => [r.id, r]));

    for (const h of g.hubs) {
        const n = addedBy.get(h) ?? 0;
        put({
            id: h, label: uname(h), showLabel: true,
            r: 12 + 14 * Math.sqrt(n / maxHub), fill: "var(--brand-500)", stroke: 3,
            font: 12, avatar: uavatar(h, 128), ringColour: RING_FRIEND,
            tip: `${uname(h)} — your friend · added by ${n} ${n === 1 ? "person" : "people"} here`
        });
    }
    for (const p of g.people) {
        const rec = byId.get(p);
        const k = rec ? rec.friends.length : 1;
        put({
            id: p, label: uname(p), showLabel: false,
            r: 7 + 5 * Math.sqrt(k), fill: "var(--green-360)", stroke: 2, font: 11,
            avatar: uavatar(p, 64), ringColour: RING_FRIEND,
            tip: `${uname(p)} — added ${k} of your friends`
        });
    }
    const links: GLink[] = [];
    const drawn = new Set<string>();
    for (const [a, b] of g.edges) {
        const ia = at.get(a), ib = at.get(b);
        if (ia === undefined || ib === undefined) continue;
        const key = ia < ib ? `${ia}|${ib}` : `${ib}|${ia}`;
        if (drawn.has(key)) continue;   // a repeated pair would desync ForceGraph's edge pairing
        drawn.add(key);
        links.push({ a: ia, b: ib, w: 1 });
    }
    return (
        <>
            <Forms.FormText style={{ opacity: 0.55, fontSize: 12, marginTop: "10px" }}>
                Blue = your friends, sized by how many people here added them. Green = the people
                who added them, sized by how many of your friends each one has.
                {g.total > g.people.length && <> Showing the {g.people.length} best-connected
                    of {g.total} — raise "Max people" to widen it.</>}
            </Forms.FormText>
            <ForceGraph spec={spec} links={links} onOpen={onOpen} height={460} />
        </>
    );
}

function FriendMapPanel({ onPick }: { onPick: (id: string) => void; }) {
    const [, force] = React.useReducer((x: number) => x + 1, 0);
    const [query, setQuery] = React.useState("");
    const [expanded, setExpanded] = React.useState<string | null>(null);
    const [pickedGuild, setPickedGuild] = React.useState<string | null>(null);
    const [asGraph, setAsGraph] = React.useState(false);

    React.useEffect(() => {
        sweepListeners.add(force);
        // Catch up on anything Mutuals answered while the modal was shut
        harvestSweep();
        return () => { sweepListeners.delete(force); };
    }, []);

    const me = UserStore.getCurrentUser()?.id ?? null;
    const progress = React.useMemo(() => buildFriendMap(sweepSeen, mutualsOf, me), [sweepVersion, me]);
    const found = React.useMemo(() => storedFriendRows(friendMap), [sweepVersion]);
    // Names resolve in the background, so a filter typed in the first seconds can miss a
    // person whose name lands afterwards. It corrects itself on the next keystroke, and
    // that is a far better trade than re-filtering the whole store on every re-render.
    const rows = React.useMemo(() => filterFriendRows(found, query, uname), [found, query]);
    const shown = rows.slice(0, 200);
    // Names for the rows on screen and for the friends named inside them
    useResolvedUsers([...shown.map(r => r.id), ...shown.flatMap(r => r.friends.slice(0, 8))], true);

    const mutualsOn = (() => { try { return MutualsAPI.isActive(); } catch { return false; } })();
    const queued = (() => { try { return MutualsAPI.pendingCount(); } catch { return 0; } })();
    const pacing = (() => {
        try { return MutualsAPI.pacing?.() ?? { delayMs: 2500, rateLimitHits: 0 }; }
        catch { return { delayMs: 2500, rateLimitHits: 0 }; }
    })();
    const totalFound = found.length;

    // Recomputed on the panel's own tick so the counts track the member list filling in
    // as you scroll it — the one action that actually gives the sweep more to work with.
    const guildChoices = React.useMemo(
        () => sweepableGuilds(allGuildIds(), guildMemberIds, guildName, me, isBotUser),
        [sweepVersion, me]);
    const totalLoaded = guildChoices.reduce((a, g) => a + g.loaded, 0);

    return (
        <>
            <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "12px", flexDirection: "column", gap: "6px", alignItems: "stretch" }}>
                <Flex style={{ gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} disabled={!mutualsOn || sweeping}
                        onClick={() => { startServerSweep(); force(); }}>
                        {sweeping ? "Sweeping…" : `Sweep every server (${totalLoaded})`}
                    </Button>
                    <Forms.FormText style={{ opacity: 0.6, fontSize: 12 }}>or</Forms.FormText>
                    <div style={{ minWidth: 220 }}>
                        <Select
                            options={guildChoices.map(g => ({
                                label: `${trunc(g.name, 28)} — ${g.loaded} loaded`, value: g.id
                            }))}
                            placeholder="Pick one server…"
                            isSelected={(v: string) => v === pickedGuild}
                            select={(v: string) => setPickedGuild(v)}
                            serialize={(v: string) => v}
                            closeOnSelect={true}
                        />
                    </div>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY}
                        disabled={!mutualsOn || sweeping || !pickedGuild}
                        onClick={() => { startServerSweep([pickedGuild!]); force(); }}>
                        Sweep this server
                    </Button>
                    {sweeping && (
                        <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY}
                            // Also pauses the automatic restarts, otherwise this button
                            // would be undone by the next tick a minute later.
                            onClick={() => { autoSweepPaused = true; stopServerSweep(); force(); }}>Stop</Button>
                    )}
                    {autoSweepPaused && !sweeping && settings.store.alwaysSweep && (
                        <Forms.FormText style={{ opacity: 0.6, fontSize: 12 }}>
                            Continuous sweeping paused — sweep again to resume it
                        </Forms.FormText>
                    )}
                    <Forms.FormText style={{ opacity: 0.7, fontSize: 12 }}>
                        {totalFound} {totalFound === 1 ? "person" : "people"} found with someone added
                    </Forms.FormText>
                </Flex>

                <Forms.FormText style={{ opacity: 0.55, fontSize: 12 }}>
                    The counts above are how many members Discord has actually sent this client, not the
                    server's size — it only delivers the member list in ranges as you scroll it, so a
                    130k-member server usually offers a few hundred. Scroll a server's member list, then
                    sweep it, to cover more.
                </Forms.FormText>

                {!mutualsOn ? (
                    <Forms.FormText style={{ color: "var(--status-warning, #f0b232)", fontSize: 12 }}>
                        Xicord Mutuals is disabled, so nothing can be proven. Enable it and come back.
                    </Forms.FormText>
                ) : progress.total > 0 ? (
                    <Forms.FormText style={{ opacity: 0.7, fontSize: 12 }}>
                        {progress.scanned}/{progress.total} people checked across {allGuildIds().length} servers
                        {progress.pending > 0 && (sweeping
                            // Mutuals paces itself, so the remaining time is arithmetic, not a guess
                            // Quoted from the pump's LIVE cadence, not a constant: it now
                            // eases down while Discord keeps answering, so a fixed 2.5s
                            // would overstate the remaining time by hours.
                            ? <> · {progress.pending} to go{queued > 0 && <> ({queued} queued)</>} · about {fmtDur(progress.pending * pacing.delayMs)} left at one check every {(pacing.delayMs / 1000).toFixed(1)}s{pacing.rateLimitHits > 0 && <> (backed off {pacing.rateLimitHits}× so far)</>}</>
                            // A rate-limited lookup leaves the queue but never answers, so a finished
                            // run with leftovers is normal — say so instead of implying it is still going
                            // Mutuals backs a failed lookup off for five minutes, so an
                            // immediate re-sweep would quietly queue nobody. Say the wait —
                            // and when the sweep re-arms itself, say that instead of asking
                            // for a click that is already happening on a timer.
                            : <> · {progress.pending} went unanswered (Discord rate-limits these lookups) — {settings.store.alwaysSweep && !autoSweepPaused ? "the sweep retries just those on its own within the minute" : "sweep again in a few minutes to retry just those"}</>)}
                        {sweepStarted > 0 && <> · started {timeAgo(sweepStarted)}</>}
                    </Forms.FormText>
                ) : (
                    <Forms.FormText style={{ opacity: 0.7, fontSize: 12 }}>
                        Nothing swept this session. A sweep queues every member Discord has loaded
                        for each of your {allGuildIds().length} servers.
                    </Forms.FormText>
                )}

                <Forms.FormText style={{ opacity: 0.55, fontSize: 12 }}>
                    Discord never reveals whose friend list you are on, so the only additions
                    provable from a client are <b>mutual</b> ones — people who added someone who is
                    also your friend. Anyone else's additions are invisible and cannot appear here.
                    A sweep only sees the members Discord has actually loaded for each server, so
                    scrolling a member list first finds more people. Results are saved, so you can
                    close this and let it fill in.
                </Forms.FormText>
            </Flex>

            <Flex style={{ gap: "8px", marginTop: "10px", alignItems: "center" }}>
                <Button size={Button.Sizes.SMALL} color={asGraph ? Button.Colors.PRIMARY : Button.Colors.BRAND}
                    onClick={() => setAsGraph(false)}>List</Button>
                <Button size={Button.Sizes.SMALL} color={asGraph ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                    onClick={() => setAsGraph(true)}>Dossier graph</Button>
                <div style={{ flexGrow: 1 }}>
                    <TextInput
                        value={query}
                        placeholder="Filter by person, or by who they added…"
                        onChange={(v: string) => setQuery(v)}
                    />
                </div>
            </Flex>

            {!rows.length ? (
                <Forms.FormText style={{ marginTop: "10px", opacity: 0.7 }}>
                    {totalFound ? `Nobody matches "${query}".` : "No findings yet — run a sweep, then leave it running."}
                </Forms.FormText>
            ) : asGraph ? (
                // The filter applies here too, so typing a friend's name narrows the graph
                // to their orbit — which is the one question the list cannot answer at all.
                <FriendGraph rows={rows} onOpen={onPick} />
            ) : (
                <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", flexDirection: "column", gap: "2px" }}>
                    {shown.map(r => {
                        const isOpen = expanded === r.id;
                        const friends = isOpen ? r.friends : r.friends.slice(0, 6);
                        return (
                            <div key={r.id} style={{ padding: "4px 0", borderBottom: "1px solid var(--background-modifier-accent)" }}>
                                <Flex style={{ flexDirection: "row", alignItems: "center", gap: "8px" }}>
                                    {/* `aria-hidden` on a control removes it from the accessibility tree
                                        entirely, which is worse than leaving it unnamed: the avatar opened
                                        a profile and there was no way to reach it but a mouse. */}
                                    <img width={24} height={24} src={uavatar(r.id, 64)} alt=""
                                        {...clickable(() => openUserProfile(r.id), {
                                            label: `Open ${uname(r.id)}'s Discord profile`,
                                            style: { borderRadius: "50%" }
                                        })} />
                                    <Forms.FormText style={{ flexGrow: 1 }}>
                                        <span {...clickable(() => onPick(r.id), { label: `Show ${uname(r.id)} in the dossier` })}>
                                            {uname(r.id)}
                                        </span>
                                    </Forms.FormText>
                                    <Forms.FormText style={{ opacity: 0.7, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
                                        added {r.friends.length} of your friends · {r.guilds.length} {r.guilds.length === 1 ? "server" : "servers"}
                                    </Forms.FormText>
                                </Flex>
                                <Flex style={{ flexWrap: "wrap", gap: "4px", marginTop: "3px", marginLeft: "32px" }}>
                                    {friends.map(f => (
                                        <div key={f}
                                            {...clickable(() => onPick(f), {
                                                label: `Show ${uname(f)} in the dossier`,
                                                style: {
                                                    display: "flex", alignItems: "center", gap: "4px", padding: "1px 6px",
                                                    borderRadius: "10px", background: "var(--background-secondary)"
                                                }
                                            })}>
                                            <img style={{ borderRadius: "50%" }} width={14} height={14} src={uavatar(f, 32)} alt="" aria-hidden="true" />
                                            <span style={{ fontSize: 11 }}>{uname(f)}</span>
                                        </div>
                                    ))}
                                    {r.friends.length > 6 && (
                                        <span {...clickable(() => setExpanded(isOpen ? null : r.id), {
                                            pressed: isOpen,
                                            style: { fontSize: 11, opacity: 0.6, alignSelf: "center" }
                                        })}>
                                            {isOpen ? "show fewer" : `+${r.friends.length - 6} more`}
                                        </span>
                                    )}
                                    <span style={{ fontSize: 11, opacity: 0.45, alignSelf: "center" }}>
                                        · in {r.guilds.map(g => GuildStore.getGuild(g)?.name ?? "a server").slice(0, 3).join(", ")}
                                        {r.guilds.length > 3 && ` +${r.guilds.length - 3}`}
                                    </span>
                                </Flex>
                            </div>
                        );
                    })}
                    {rows.length > shown.length && (
                        <Forms.FormText style={{ opacity: 0.6, fontSize: 12, marginTop: "6px" }}>
                            Showing the top {shown.length} of {rows.length} — narrow it with the filter above.
                        </Forms.FormText>
                    )}
                </Flex>
            )}
        </>
    );
}

function DossierModal({ initial, ...props }: RenderModalProps & { initial?: string; }) {
    // The tick is kept rather than discarded: it moves when the reconcile below finds new
    // data, which is the only thing that can change anything derived from the dossier. It
    // is therefore the right key for every memo in this component — and, just as
    // importantly, typing in the picker does NOT move it.
    const [tick, force] = React.useReducer((x: number) => x + 1, 0);
    // Filters and sorts every recorded profile; was doing so on every keystroke.
    const watched = React.useMemo(() => dossierSubjects(), [tick]);
    const isTarget = (id: string) => WatchAPI.has(id);
    // "View Dossier" on someone with no log used to fall back to watched[0] in silence,
    // so you were shown a completely different person's dossier with nothing saying so.
    // Honour the click: view exactly who was asked for, even if nothing is recorded
    // yet — an immediate reconcile below captures their current call on the spot.
    const [target, setTarget] = React.useState(initial || watched[0]);
    const [mode, setMode] = React.useState<"one" | "all" | "friends">("one");
    const full = mode === "all";
    const [maxNodes, setMaxNodes] = React.useState(String(settings.store.fullGraphNodes ?? FULL_GRAPH_NODES));
    const [pickerQuery, setPickerQuery] = React.useState("");
    // Who we were centred on before the last re-centre. Kept on screen greyed out so
    // walking the network reads as a journey rather than the web being replaced.
    const [ghost, setGhost] = React.useState<string | undefined>(undefined);

    /** Right-clicking someone in the network makes them the new subject. */
    const recentre = (id: string) => {
        if (!id || id === target) return;
        setGhost(target);
        setTarget(id);
        setPickerQuery("");
    };
    /** Picking from the list is a deliberate jump, so it drops the trail. */
    const jumpTo = (id: string) => { setGhost(undefined); setTarget(id); setPickerQuery(""); };
    // resolve the names in the picker too, behind whatever the graph asked for
    useResolvedUsers(watched);

    // The dossier only fills in from voice-state updates over time, so opening it on
    // someone used to show nothing until the next update happened to fire. Reconcile
    // the viewed person right now — if they're in a public/locked call this captures
    // their companions instantly — and keep it live while the modal is open.
    React.useEffect(() => {
        if (!target) return;
        try { reconcile(target); } catch { }
        force();
        const iv = setInterval(() => { try { reconcile(target); force(); } catch { } }, 4000);
        return () => clearInterval(iv);
    }, [target]);

    // Everyone in the dossier gets a mutual-friend scan, plus a ONE-TIME sweep of
    // the current server's loaded member list (kept current afterwards by the
    // GUILD_MEMBER_ADD handler). Mutuals throttles and caches, so this is a slow
    // background fill rather than a burst of requests.
    React.useEffect(() => {
        scanForMutuals(watched);
        if (!settings.store.scanMembers) return;
        try { sweepGuildMembers((SelectedGuildStore as any).getGuildId?.()); } catch { }
    }, [watched.join(",")]);

    const me = UserStore.getCurrentUser()?.id ?? null;

    /*
     * Everything the dossier displays, derived once per change of subject or of data.
     *
     * This block used to run on every render, and two things render this component
     * constantly: the picker's TextInput sets state on every keystroke, and the reconcile
     * interval fires every four seconds. Each pass cloned the whole profile (viewProfile),
     * re-derived the subject's proven friends, and ran three full sorts. Typing a name into
     * the picker did all of it per character.
     */
    const { view, myChannel, companions, guilds, games } = React.useMemo(() => {
        const v = target ? viewProfile(target) : null;
        // Who the SUBJECT has added, so their own friends lead the "Calls with" list rather
        // than being buried under strangers they happen to share a busy channel with.
        const friends = target ? (() => { try { return provenFriends(target); } catch { return null; } })() : null;
        return {
            view: v,
            // read once, not once per row — every companion is compared against it
            myChannel: myVoiceChannel(),
            companions: v ? orderCompanions(Object.entries(v.companions), friends) : [],
            guilds: v ? Object.entries(v.guilds).sort((a, b) => b[1] - a[1]) : [],
            games: v ? Object.entries(v.games ?? {}).sort((a, b) => b[1].ms - a[1].ms) : [],
        };
    }, [target, tick]);

    /*
     * Who is in a call right now, for the rows that are actually drawn.
     *
     * liveCall() enumerates a channel's occupants, and channelOccupants() falls back to
     * scanning the guild's ENTIRE voice-state map whenever the per-channel map comes back
     * empty — which is what happens for a channel you cannot join. Calling it inline per row
     * meant up to sixty of those scans per render. Companions in a call together share a
     * channel, so one cache across the batch collapses most of them to a single lookup, and
     * the whole batch is recomputed only when the live data moves.
     */
    const liveByCompanion = React.useMemo(() => {
        const seen = new Map<string, Record<string, any>>();
        const occupantsOf = (channelId: string, guildId?: string) => {
            const k = `${channelId}|${guildId ?? ""}`;
            let v = seen.get(k);
            if (v === undefined) { v = channelOccupants(channelId, guildId); seen.set(k, v); }
            return v;
        };
        const out = new Map<string, ReturnType<typeof liveCall>>();
        for (const c of companions.slice(0, COMPANIONS_SHOWN)) {
            out.set(c.id, liveCall(c.id, liveStateOf, occupantsOf, me));
        }
        return out;
    }, [companions, me, tick]);

    // Walks every profile's companions with a store call per element; was inline in JSX.
    const knownPeople = React.useMemo(() => totalKnownPeople(), [tick]);

    return (
        <ModalRoot {...props} size={ModalSize.LARGE}>
            <ModalHeader>
                <DossierIcon big />
                <Forms.FormTitle tag="h4" style={{ marginLeft: "10px" }}>Xicord Dossier</Forms.FormTitle>
            </ModalHeader>
            <ModalContent>
                <Forms.FormText style={{ marginTop: "10px", opacity: 0.7 }}>
                    A profile that builds up over time of who your watched people share <b>public-server</b>
                    voice channels with. DMs and group calls are never recorded.
                </Forms.FormText>
                <Forms.FormText style={{ marginTop: "4px", opacity: 0.55, fontSize: 12 }}>
                    Scroll to zoom, drag a node to move it, drag the background to pan, double-click
                    a node to open their profile, right-click to re-centre, double-click the background
                    to reset. Hover for time in call.
                </Forms.FormText>
                <Forms.FormText style={{ marginTop: "4px", opacity: 0.55, fontSize: 12 }}>
                    A <span style={{ color: "var(--yellow-300, #f0b132)", fontWeight: 700 }}>gold ring</span> means a
                    proven friendship; a plain ring means you have only ever seen them in a call together.
                    Discord never reveals someone else's friend list, so the only friendships detectable are{" "}
                    <b>mutual</b> ones — people who are friends with you as well. Anyone they added who isn't
                    also your friend cannot be seen and stays plain. Needs Xicord Mutuals enabled.
                </Forms.FormText>

                {mode === "one" && target && !companions.length && !view?.updated && (
                    <Forms.FormText style={{ marginTop: "10px", color: "var(--status-warning, #f0b232)" }}>
                        Nothing recorded for <b>{uname(target)}</b> yet, and they aren't in a public
                        voice call right now (checked live). The Dossier fills in whenever they share a
                        public-server call with someone. Right-click them and choose "Watch User" to keep
                        logging them going forward.
                    </Forms.FormText>
                )}

                {/* The friend map is not built from watched people, so its button — and
                    the view itself — stay available even with an empty dossier. */}
                <>
                        <Flex style={{ gap: "8px", marginTop: "12px", alignItems: "center", flexWrap: "wrap" }}>
                            <Button size={Button.Sizes.SMALL} color={mode === "one" ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                                onClick={() => setMode("one")}>One person</Button>
                            <Button size={Button.Sizes.SMALL} color={mode === "all" ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                                onClick={() => setMode("all")}>Full dossier — everyone</Button>
                            <Button size={Button.Sizes.SMALL} color={mode === "friends" ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                                onClick={() => setMode("friends")}>Who added who — every server</Button>
                            {/* match whichever view is on screen: the dashboard has both.
                                Hoisting this row out of the empty-dossier branch (so the friend
                                map is reachable with nothing watched) also exposed these to a
                                dossier with nothing in it — they configure a graph that has
                                nothing to draw, so they stay behind the same condition as before. */}
                            {mode !== "friends" && watched.length > 0 && (
                                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} look={Button.Looks.LINK}
                                    onClick={() => openDashboard(full)}>Open in dashboard ↗</Button>
                            )}
                            {full && watched.length > 0 && (
                                <>
                                    <Forms.FormText style={{ opacity: 0.6, fontSize: 12 }}>Max people</Forms.FormText>
                                    <div style={{ width: 84 }}>
                                        <TextInput
                                            value={maxNodes}
                                            placeholder="150"
                                            onChange={(v: string) => {
                                                setMaxNodes(v);
                                                const parsed = parseInt(v, 10);
                                                if (Number.isFinite(parsed)) {
                                                    settings.store.fullGraphNodes = Math.max(MIN_GRAPH_NODES, Math.min(MAX_GRAPH_NODES, parsed));
                                                }
                                            }}
                                        />
                                    </div>
                                    <Forms.FormText style={{ opacity: 0.6, fontSize: 12 }}>
                                        of {knownPeople} recorded ({MIN_GRAPH_NODES}–{MAX_GRAPH_NODES}).
                                        Best-connected first · blue = your Target trait · gold ring = proven friend.
                                        {(() => {
                                            // names arrive slowly (one lookup every 220ms), so say how far along it is
                                            const n = nameSweepProgress();
                                            const gone = n.unresolvable ? ` ${n.unresolvable} account${n.unresolvable === 1 ? "" : "s"} no longer exist.` : "";
                                            if (!n.missing) return ` All ${n.total} names resolved.${gone}`;
                                            return ` Resolving names: ${n.total - n.missing}/${n.total} done, ${n.missing} to go.${gone}`;
                                        })()}
                                    </Forms.FormText>
                                </>
                            )}
                        </Flex>

                        {mode === "friends" ? (
                            <FriendMapPanel onPick={id => { setMode("one"); jumpTo(id); }} />
                        ) : watched.length === 0 && !target ? (
                            // `target` may be someone the dossier has never tracked — opened from
                            // the friend map, or from "View Dossier" on a stranger. Showing them
                            // the "add someone first" message would swallow the click they just made.
                            <Forms.FormText style={{ marginTop: "12px" }}>No watched users yet — add some via Orbit's "Watch User".</Forms.FormText>
                        ) : (
                    <>
                        {full && <FullGraph />}

                        {!full && (() => {
                            // The list is hidden until you type — otherwise a large dossier is a
                            // wall of chips. The person you're viewing still shows below regardless.
                            const q = pickerQuery.trim().toLowerCase();
                            const { ids: matches, keyword, matched } = pickerMatches(pickerQuery, watched, uname, isTarget);
                            return (
                                <>
                                    <div style={{ marginTop: "12px" }}>
                                        <TextInput
                                            value={pickerQuery}
                                            placeholder={`Search your ${watched.length} dossier ${watched.length === 1 ? "person" : "people"} by name or ID — or type "watched" for just the ones you added…`}
                                            onChange={(v: string) => setPickerQuery(v)}
                                        />
                                    </div>
                                    {/* The truncation note is NOT keyword-only: a plain search is capped
                                        at 60, and silently showing 60 of 300 reads as "they aren't here". */}
                                    {(keyword || matched > matches.length) && (
                                        <Forms.FormText style={{ opacity: 0.6, fontSize: 12, marginTop: "6px" }}>
                                            {keyword === "watched"
                                                ? `Your ${matched} watched ${matched === 1 ? "person" : "people"} — the Target trait itself, not the ${watched.length - matched} others propagation pulled in.`
                                                : keyword === "all"
                                                    ? `All ${matched} people in your dossier.`
                                                    : `${matched} people match.`}
                                            {matched > matches.length && ` Showing the first ${matches.length} — keep typing to narrow it.`}
                                        </Forms.FormText>
                                    )}
                                    {q ? (
                                        <Flex style={{ flexWrap: "wrap", gap: "6px", marginTop: "8px" }}>
                                            {matches.length ? matches.map(id => (
                                                <div key={id}
                                                    {...clickable(() => jumpTo(id), {
                                                        label: `Show ${uname(id)} in the dossier`,
                                                        pressed: id === target,
                                                        style: {
                                                            display: "flex", alignItems: "center", gap: "6px", padding: "3px 8px", borderRadius: "12px",
                                                            background: id === target ? "var(--brand-500, #5865f2)" : "var(--background-secondary)",
                                                            color: id === target ? "#fff" : "var(--text-normal)"
                                                        }
                                                    })}>
                                                    <img style={{ borderRadius: "50%" }} width={18} height={18} src={uavatar(id)} alt="" aria-hidden="true" />
                                                    <span style={{ fontSize: 12 }}>{uname(id)}</span>
                                                    {isTarget(id) ? null : (
                                                        <span title="Reached by propagation — not on your Target trait" style={{ fontSize: 10, opacity: 0.65 }}>↳</span>
                                                    )}
                                                </div>
                                            )) : (
                                                <Forms.FormText style={{ opacity: 0.6, fontSize: 12 }}>
                                                    {keyword === "watched"
                                                        ? "None of your dossier people are on the Target trait — everyone here arrived through propagation."
                                                        : `No one in your dossier matches "${pickerQuery}".`}
                                                </Forms.FormText>
                                            )}
                                        </Flex>
                                    ) : null}
                                </>
                            );
                        })()}

                        {view && !full && (
                            <>
                                <Flex style={{ gap: "16px", marginTop: "14px", alignItems: "center" }}>
                                    <img width={44} height={44} src={uavatar(target!)} alt=""
                                        {...clickable(() => openUserProfile(target!), {
                                            label: `Open ${uname(target!)}'s Discord profile`,
                                            style: { borderRadius: "50%" }
                                        })} />
                                    <div>
                                        <Forms.FormTitle tag="h4" style={{ margin: 0 }}>{uname(target!)}</Forms.FormTitle>
                                        <Forms.FormText style={{ opacity: 0.6, fontSize: 12 }}>
                                            {companions.length} companion{companions.length === 1 ? "" : "s"} ·
                                            {" "}since {view.firstSeen ? new Date(view.firstSeen).toLocaleDateString() : "—"} ·
                                            {" "}updated {timeAgo(view.updated)}
                                        </Forms.FormText>
                                    </div>
                                </Flex>

                                <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "12px", flexDirection: "column" }}>
                                    <Forms.FormTitle tag="h5" style={{ marginTop: "5px" }}>Companion network</Forms.FormTitle>
                                    {companions.length > 0 ? (
                                        <>
                                            <Forms.FormText style={{ opacity: 0.55, fontSize: 12, marginBottom: "4px" }}>
                                                Right-click anyone to centre the view on them. Left-click still opens their Discord profile.
                                                {ghost ? (
                                                    <>
                                                        {" "}Came from <b>{uname(ghost)}</b>, still shown faded —{" "}
                                                        {/* the only way to undo a re-centre, so it has to be reachable */}
                                                        <span {...clickable(() => jumpTo(ghost), { style: { color: "var(--text-link)" } })}>go back</span>
                                                        {" · "}
                                                        <span {...clickable(() => setGhost(undefined), { style: { color: "var(--text-link)" } })}>clear trail</span>
                                                    </>
                                                ) : null}
                                            </Forms.FormText>
                                            <NetworkGraph targetId={target!} view={view}
                                                ghostId={ghost} ghostView={ghost ? viewProfile(ghost) : null}
                                                onRecentre={recentre} />
                                        </>
                                    ) : (
                                        // Landing on someone with nothing recorded clears the graph outright. Keeping
                                        // the previous person's faded web on screen made it look like their network,
                                        // so the empty state says so plainly and offers the way back instead.
                                        <Forms.FormText style={{ opacity: 0.7, fontSize: 13, marginBottom: "4px" }}>
                                            Nothing recorded for <b>{uname(target!)}</b> yet, so there's no network to draw.
                                            It fills in as they turn up in public-server voice channels.
                                            {ghost ? (
                                                <>
                                                    {" — "}
                                                    <span {...clickable(() => jumpTo(ghost), { style: { color: "var(--text-link)" } })}>
                                                        back to {uname(ghost)}
                                                    </span>
                                                </>
                                            ) : null}
                                        </Forms.FormText>
                                    )}
                                </Flex>

                                <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "12px", flexDirection: "column" }}>
                                    <Forms.FormTitle tag="h5" style={{ marginTop: "5px" }}>Calls with</Forms.FormTitle>
                                    {companions.some(c => c.added) && (
                                        <Forms.FormText style={{ opacity: 0.55, fontSize: 12, marginBottom: "4px" }}>
                                            People <b>{uname(target!)}</b> has added come first, most recently in a call at
                                            the top. Everyone below is ordered by how much they have been seen together.
                                        </Forms.FormText>
                                    )}
                                    {companions.length ? companions.slice(0, COMPANIONS_SHOWN).map(({ id: cid, rec, added }) => {
                                        // Everything else on this row is history. This one line is live, so it
                                        // is the only thing here that can be acted on right now — hence
                                        // naming who is in there rather than just "online".
                                        //
                                        // The green is spent on ONE state: they are in the channel you are in.
                                        // Someone in a different channel is still worth picking out from
                                        // someone out of voice entirely, so they get the brighter text without
                                        // the colour, and everyone else is dimmed back.
                                        const live = liveByCompanion.get(cid) ?? null;
                                        const tier = voiceTier(live, myChannel);
                                        const withWhom = live
                                            ? (tier === "with-me"
                                                ? "in this call with you"
                                                : live.others.length
                                                    ? `in a call with ${live.others.slice(0, 4).map(uname).join(", ")}`
                                                    + (live.others.length > 4 ? ` +${live.others.length - 4}` : "")
                                                    : "in a voice channel alone")
                                            : "";
                                        return (
                                            <Flex key={cid} style={{ gap: "10px", flexDirection: "row", alignItems: "center" }}>
                                                <img width={24} height={24} src={uavatar(cid)} alt=""
                                                    {...clickable(() => openUserProfile(cid), {
                                                        // The ring is colour-only, so what it means goes in the name too.
                                                        label: `Open ${uname(cid)}'s Discord profile`
                                                            + (tier === "with-me" ? " — in this call with you" : "")
                                                            + (added ? " — proven friend" : ""),
                                                        style: {
                                                            borderRadius: "50%",
                                                            // gold = a proven friendship, green = in here with you right
                                                            // now. Green wins the ring: the friendship will still be true
                                                            // in an hour, the shared channel will not.
                                                            boxShadow: tier === "with-me" ? `0 0 0 2px ${RING_LIVE}`
                                                                : added ? `0 0 0 2px ${RING_FRIEND}` : undefined,
                                                            opacity: tier === "away" ? 0.65 : 1
                                                        }
                                                    })} />
                                                <Forms.FormText style={{
                                                    flexGrow: 1,
                                                    color: tier === "with-me" ? RING_LIVE
                                                        : tier === "elsewhere" ? "var(--text-normal)" : undefined,
                                                    opacity: tier === "away" ? 0.65 : 1
                                                }}>
                                                    {uname(cid)}
                                                </Forms.FormText>
                                                {live && (
                                                    <span title={withWhom + (live.guildId ? ` — ${guildName(live.guildId)}` : "")}
                                                        style={{
                                                            fontSize: 11, whiteSpace: "nowrap",
                                                            color: tier === "with-me" ? RING_LIVE : "var(--text-muted, #b5bac1)"
                                                        }}>
                                                        ● {withWhom}
                                                    </span>
                                                )}
                                                {added && (
                                                    <span title={`${uname(target!)} has added them — a proven, mutual friendship`}
                                                        style={{
                                                            fontSize: 10, textTransform: "uppercase", letterSpacing: ".04em",
                                                            color: RING_FRIEND, fontWeight: 700
                                                        }}>added</span>
                                                )}
                                                <Forms.FormText style={{ opacity: 0.7, fontVariantNumeric: "tabular-nums" }}>{rec.count}× · {fmtDur(rec.ms)}</Forms.FormText>
                                                <Forms.FormText style={{ opacity: 0.45, fontSize: 12, minWidth: 62, textAlign: "right" }}>{timeAgo(rec.last)}</Forms.FormText>
                                            </Flex>
                                        );
                                    }) : <Forms.FormText>Nothing observed yet — this fills in as they hang out in public voice channels.</Forms.FormText>}
                                </Flex>

                                {games.length > 0 && (
                                    <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "12px", flexDirection: "column" }}>
                                        <Forms.FormTitle tag="h5" style={{ marginTop: "5px" }}>Games played</Forms.FormTitle>
                                        {games.slice(0, 12).map(([name, rec]) => (
                                            <Flex key={name} style={{ flexDirection: "row", alignItems: "center" }}>
                                                <Forms.FormText style={{ flexGrow: 1 }}>{name}</Forms.FormText>
                                                <Forms.FormText style={{ opacity: 0.7, fontVariantNumeric: "tabular-nums" }}>{fmtDur(rec.ms)} · {rec.sessions}×</Forms.FormText>
                                                <Forms.FormText style={{ opacity: 0.45, fontSize: 12, minWidth: 62, textAlign: "right" }}>{timeAgo(rec.last)}</Forms.FormText>
                                            </Flex>
                                        ))}
                                    </Flex>
                                )}

                                {guilds.length > 0 && (
                                    <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "12px", flexDirection: "column" }}>
                                        <Forms.FormTitle tag="h5" style={{ marginTop: "5px" }}>Servers</Forms.FormTitle>
                                        {guilds.slice(0, 10).map(([g, n]) => (
                                            <Flex key={g} style={{ flexDirection: "row", alignItems: "center" }}>
                                                <Forms.FormText style={{ flexGrow: 1 }}>{GuildStore.getGuild(g)?.name ?? "a server"}</Forms.FormText>
                                                <Forms.FormText style={{ opacity: 0.7 }}>{n} meet-ups</Forms.FormText>
                                            </Flex>
                                        ))}
                                    </Flex>
                                )}

                                {(() => {
                                    // What the all-server sweep proved about this person: the ones
                                    // they added who are your friends too. Live scan first, then
                                    // whatever a previous sweep banked — the scan cache is memory-only.
                                    const proven = [...(provenFriends(target!) ?? [])].filter(f => f !== target);
                                    if (!proven.length) return null;
                                    // Which of these this machine could not see on its own. Worth
                                    // marking: a name only the pool can vouch for is a weaker claim
                                    // than one you watched the scanner prove.
                                    const fromPoolOnly = new Set(pooledOnly(target!));
                                    return (
                                        <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "12px", flexDirection: "column" }}>
                                            <Forms.FormTitle tag="h5" style={{ marginTop: "5px" }}>Added ({proven.length})</Forms.FormTitle>
                                            <Forms.FormText style={{ opacity: 0.55, fontSize: 12, marginBottom: "4px" }}>
                                                People {uname(target!)} has added who are friends of yours as well — the
                                                only additions a client can prove. Found by the all-server sweep.
                                                {fromPoolOnly.size > 0 && <> {fromPoolOnly.size} of these your own scanner
                                                    cannot see; they came from another contributor's sweep and are marked ↗.</>}
                                            </Forms.FormText>
                                            <Flex style={{ flexWrap: "wrap", gap: "6px" }}>
                                                {proven.slice(0, 60).map(f => (
                                                    <div key={f}
                                                        title={fromPoolOnly.has(f)
                                                            ? "Proven by another contributor's sweep — your own scanner cannot see this one"
                                                            : "Proven by this machine's own scanner"}
                                                        {...clickable(() => jumpTo(f), {
                                                            // `title` is a hover affordance and gives no name without a
                                                            // pointer, so the provenance goes into the label as well.
                                                            label: `Show ${uname(f)} in the dossier`
                                                                + (fromPoolOnly.has(f) ? " — proven by another contributor's sweep" : ""),
                                                            style: {
                                                                display: "flex", alignItems: "center", gap: "6px", padding: "3px 8px",
                                                                borderRadius: "12px", background: "var(--background-secondary)"
                                                            }
                                                        })}>
                                                        <img style={{ borderRadius: "50%" }} width={18} height={18} src={uavatar(f)} alt="" aria-hidden="true" />
                                                        <span style={{ fontSize: 12 }}>{uname(f)}</span>
                                                        {fromPoolOnly.has(f) && <span style={{ fontSize: 10, opacity: 0.55 }}>↗</span>}
                                                    </div>
                                                ))}
                                            </Flex>
                                        </Flex>
                                    );
                                })()}
                            </>
                        )}
                    </>
                )}
                </>

                <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "12px", flexDirection: "column" }}>
                    <Switch value={settings.store.announceNew} onChange={(v: boolean) => { settings.store.announceNew = v; }}>
                        Toast when a target calls with someone new
                    </Switch>
                </Flex>

                <Flex style={{ marginTop: "12px", marginBottom: "10px", gap: "10px", justifyContent: "flex-end" }}>
                    {/* Only in the one-person view: this deletes whoever `target` is, and in the
                        other views that person is nowhere on screen — an unnamed, unconfirmed
                        delete of someone you weren't even looking at. */}
                    {mode === "one" && target && (
                        <Button color={Button.Colors.RED} onClick={() => { delete profiles[target!]; open.delete(target!); dirty = true; flush(); props.onClose(); }}>Clear this profile</Button>
                    )}
                    <Button color={Button.Colors.GREEN} onClick={() => props.onClose()}>Close</Button>
                </Flex>
            </ModalContent>
        </ModalRoot>
    );
}

function DossierIcon({ big }: { big?: boolean; }) {
    const s = big ? 20 : 18;
    return <svg width={s} height={s} viewBox="0 0 24 24"><g fill={big ? "#b5bac1" : "currentColor"}>
        <path d="M4 3h9l3 3h4a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" opacity=".5" />
        <path d="M12 9a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm-4 8c0-1.7 1.8-3 4-3s4 1.3 4 3v1H8v-1Z" />
    </g></svg>;
}
function dossierButton() {
    return <Button2 onClick={() => openModal(p => <DossierModal {...p} />)} onContextMenu={() => openModal(p => <DossierModal {...p} />)}
        role="switch" tooltipText="Xicord Dossier" icon={() => <DossierIcon />} />;
}

// How often the "Find Who Added Them" modal kicks the sweep again while it is open. With
// alwaysSweep on, autoSweepTick already does this forever and this is only the faster
// cadence someone watching the numbers deserves; with it off, this is what makes the view
// live at all. Either way it fires only when no run is in flight, so it RESUMES a drained
// run rather than restarting a healthy one and resetting its progress clock.
const WHO_ADDED_RESWEEP = 45000;

function WhoAddedModal(props: RenderModalProps & { target: string; }) {
    const { target } = props;
    const [, force] = React.useReducer((x: number) => x + 1, 0);

    React.useEffect(() => {
        sweepListeners.add(force);
        // Start one on open unless a run is already in flight — restarting a healthy run
        // would throw away its progress clock and re-collect the same members.
        if (!sweeping) startServerSweep();
        harvestSweep();
        const resweep = setInterval(() => { if (active && !sweeping) startServerSweep(); }, WHO_ADDED_RESWEEP);
        // The panel's own tick, so the progress line and ETA advance between sweep events
        const tick = setInterval(force, 4000);
        return () => {
            sweepListeners.delete(force);
            clearInterval(resweep);
            clearInterval(tick);
            // The sweep outlives this modal now. Cancelling the queue on close is only
            // right when nothing else is going to consume the answers — with continuous
            // sweeping on, it would tear down the very run that is supposed to be
            // permanent every time someone glanced at this and shut it.
            if (!settings.store.alwaysSweep) stopServerSweep();
        };
    }, [target]);

    const me = UserStore.getCurrentUser()?.id ?? null;
    const result = React.useMemo(
        () => whoAdded(target, whoAddedCandidates(), provenFriends, guildsForCandidate, me),
        [sweepVersion, target, me]);
    const shown = result.rows.slice(0, 200);
    useResolvedUsers([target, ...shown.map(r => r.id)], true);

    const mutualsOn = (() => { try { return MutualsAPI.isActive(); } catch { return false; } })();
    const targetIsFriend = (() => { try { return !!(RelationshipStore as any).isFriend?.(target); } catch { return false; } })();
    const pacing = (() => {
        try { return MutualsAPI.pacing?.() ?? { delayMs: 2500, rateLimitHits: 0 }; }
        catch { return { delayMs: 2500, rateLimitHits: 0 }; }
    })();
    const queued = (() => { try { return MutualsAPI.pendingCount(); } catch { return 0; } })();

    return (
        <ModalRoot {...props} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <DossierIcon />
                <Forms.FormTitle tag="h4" style={{ marginLeft: "10px" }}>
                    Who added {uname(target)}
                </Forms.FormTitle>
            </ModalHeader>
            <ModalContent>
                <Forms.FormText style={{ marginTop: "10px", opacity: 0.7, fontSize: 13 }}>
                    Everyone the sweep can prove has <b>{uname(target)}</b> added as a friend. The sweep
                    {settings.store.alwaysSweep ? " runs continuously in the background and keeps re-running itself whether or not this is open" : " is running and re-runs itself while this is open"},
                    widening as Discord streams in more members — scroll a server's member list to feed it more.
                </Forms.FormText>

                {!mutualsOn && (
                    <Forms.FormText style={{ marginTop: "8px", color: "var(--status-warning, #f0b232)", fontSize: 12 }}>
                        Xicord Mutuals is disabled, so nothing can be proven. Enable it and reopen this.
                    </Forms.FormText>
                )}
                {mutualsOn && !targetIsFriend && (
                    <Forms.FormText style={{ marginTop: "8px", color: "var(--status-warning, #f0b232)", fontSize: 12 }}>
                        {uname(target)} is not on your friends list. Discord only reveals <b>mutual</b>
                        friendships, so a person you have not added can never be proven to be on anyone's
                        list — this will stay empty however long it sweeps.
                    </Forms.FormText>
                )}

                <Forms.FormText style={{ marginTop: "8px", opacity: 0.7, fontSize: 12 }}>
                    {result.rows.length} found · {result.scanned}/{result.total} checked
                    {result.pending > 0 && (sweeping
                        ? <> · {result.pending} to go{queued > 0 && <> ({queued} queued)</>} · ~{fmtDur(result.pending * pacing.delayMs)} left</>
                        : <> · {result.pending} not yet checked — sweeping again shortly</>)}
                    {sweeping && <> · Sweeping…</>}
                </Forms.FormText>

                <Flex style={{ flexDirection: "column", gap: "6px", marginTop: "12px" }}>
                    {shown.length === 0
                        ? <Forms.FormText style={{ opacity: 0.6 }}>
                            {result.scanned === 0
                                ? "Nothing checked yet — the sweep is warming up."
                                : "Nobody proven to have added them yet."}
                        </Forms.FormText>
                        : shown.map(row => (
                            <Flex key={row.id} style={{ gap: "10px", alignItems: "center" }}>
                                <img style={{ borderRadius: "50%" }} aria-hidden="true" height={28} width={28}
                                    src={uavatar(row.id, 32)} />
                                <Forms.FormText style={{ flexGrow: 1 }}>{uname(row.id)}</Forms.FormText>
                                {row.guilds.length > 0 && (
                                    <Forms.FormText style={{ opacity: 0.5, fontSize: 12 }}>
                                        {row.guilds.length} {row.guilds.length === 1 ? "server" : "servers"}
                                    </Forms.FormText>
                                )}
                                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY}
                                    onClick={() => openModal(p => <DossierModal {...p} initial={row.id} />)}>
                                    Dossier
                                </Button>
                            </Flex>
                        ))}
                    {result.rows.length > shown.length && (
                        <Forms.FormText style={{ opacity: 0.5, fontSize: 12 }}>
                            …and {result.rows.length - shown.length} more.
                        </Forms.FormText>
                    )}
                </Flex>

                <Flex style={{ marginTop: "12px", marginBottom: "8px", justifyContent: "flex-end" }}>
                    <Button color={Button.Colors.GREEN} onClick={() => props.onClose()}>Close</Button>
                </Flex>
            </ModalContent>
        </ModalRoot>
    );
}

function makeContextMenuPatch(): NavContextMenuPatchCallback {
    return (children, props) => {
        const id = props?.user?.id;
        if (!id) return;
        const me = UserStore.getCurrentUser()?.id ?? null;
        children.splice(-1, 0,
            <Menu.MenuGroup>
                <Menu.MenuItem id="xicord-dossier-view" label="View Dossier"
                    action={() => openModal(p => <DossierModal {...p} initial={id} />)} />
                {id !== me && (
                    <Menu.MenuItem id="xicord-who-added" label="Find Who Added Them"
                        action={() => openModal(p => <WhoAddedModal {...p} target={id} />)} />
                )}
            </Menu.MenuGroup>
        );
    };
}

export default definePlugin({
    name: "Xicord Dossier",
    description: "Slowly builds a profile of who each watched person shares public-server voice channels with, and how often — optionally spreading outward through the call graph to their companions too",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    dependencies: ["Xicord Mod Menu", "Xicord Orbit"],
    settings,
    xicordButton: ErrorBoundary.wrap(dossierButton, { noop: true }),
    contextMenus: { "user-context": makeContextMenuPatch() },
    // Fires on login and on every account switch
    flux: {
        CONNECTION_OPEN: onConnectionOpen,
        // A profile you opened is a person you care about — get them on the roster so
        // the free mutual-friend answer has somewhere to land.
        USER_PROFILE_FETCH_SUCCESS: onProfileOpened,
        USER_PROFILE_MODAL_OPEN: onProfileOpened,
    },
    start() {
        active = true;
        loaded = false;
        WatchAPI.subscribe(onWatchChanged);
        // Per-account settings config. Run early and independently of the profile load:
        // on a same-account restart it just re-banks the fields (no change), and on a
        // logged-in-account-changed-while-closed start it restores this account's config.
        void loadAccountConfig().then(() => {
            if (active) try { initAccountConfig(UserStore.getCurrentUser()?.id ?? null); } catch (e) { console.error("Xicord Dossier: config init failed", e); }
        });
        // The store is read asynchronously now, so the seeding pass has to wait for it:
        // profiles ARE the propagation graph, and walking it empty would track nobody.
        void load().then(() => {
            if (!active) return;
            trackedDirty = true;
            // seed open overlaps from whoever is already in a public VC
            try { for (const id of trackedSet()) reconcile(id); } catch { }
            // Fill in the names the dashboard is missing. Throttled by the resolve pump,
            // and anyone already named costs nothing, so this quietly catches up. Repeats
            // so people met since the last pass get names too, and so anything the pump
            // deferred behind a rate-limit pause is picked back up.
            setTimeout(sweepNames, 10000);
            sweepTimer = setInterval(sweepNames, 10 * 60 * 1000);
            // Roster: pick up whatever Discord has handed over, then keep Mutuals topped
            // up from it forever. This is what lets a big server finish across sessions
            // instead of only covering whoever was loaded when the button was pressed.
            setTimeout(() => { harvestRoster(); silentSweepTick(); }, 15000);
            silentTimer = setInterval(silentSweepTick, SILENT_TICK);
            // The who-added sweep itself, running from startup and re-arming forever —
            // no modal, no button. Started after the roster harvest so the first run
            // collects everything Discord has already handed over.
            setTimeout(autoSweepTick, 18000);
            autoSweepTimer = setInterval(autoSweepTick, AUTO_SWEEP_TICK);
            // First sync shortly after load (a full one, so a new machine gets the lot),
            // then deltas on a timer.
            setTimeout(() => syncTick(), 20000);
            syncTimer = setInterval(syncTick, SYNC_TICK);
        });
        FluxDispatcher.subscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
        FluxDispatcher.subscribe("GUILD_MEMBER_ADD", onGuildMemberAdd);
        // fires as a member list streams in while you scroll it — the moment there is
        // genuinely more of a server to sweep
        FluxDispatcher.subscribe("GUILD_MEMBER_LIST_UPDATE", onGuildMemberListUpdate);
        FluxDispatcher.subscribe("PRESENCE_UPDATES", onPresenceUpdates);
        // Every answer Mutuals gets is a possible sweep finding, so bank them as they
        // land — a sweep runs for hours and must not depend on the modal being open.
        try { MutualsAPI.subscribe(scheduleHarvest); } catch { }
    },
    stop() {
        active = false;
        if (sweepTimer != null) { clearInterval(sweepTimer); sweepTimer = null; }
        if (silentTimer != null) { clearInterval(silentTimer); silentTimer = null; }
        if (autoSweepTimer != null) { clearInterval(autoSweepTimer); autoSweepTimer = null; }
        // A fresh enable starts sweeping again; a pause is a this-session decision about a
        // running plugin, not something to carry across a restart of it.
        autoSweepPaused = false;
        if (syncTimer != null) { clearInterval(syncTimer); syncTimer = null; }
        if (harvestTimer != null) { clearTimeout(harvestTimer); harvestTimer = null; }
        try { MutualsAPI.unsubscribe(scheduleHarvest); } catch { }
        // Xicord Mutuals is a SEPARATE plugin and keeps running, so leaving thousands of
        // our queued people behind would have it fetching one every 2.5s for hours with
        // nobody left to consume a single answer.
        stopServerSweep();
        sweepSeen = new Map();
        roster = {};
        folded.clear();
        stopResolving();
        sweptGuilds.clear();
        WatchAPI.unsubscribe(onWatchChanged);
        FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
        FluxDispatcher.unsubscribe("GUILD_MEMBER_ADD", onGuildMemberAdd);
        FluxDispatcher.unsubscribe("GUILD_MEMBER_LIST_UPDATE", onGuildMemberListUpdate);
        if (widenTimer != null) { clearTimeout(widenTimer); widenTimer = null; }
        widenPending.clear();
        FluxDispatcher.unsubscribe("PRESENCE_UPDATES", onPresenceUpdates);
        // close all open overlaps into totals
        const now = Date.now();
        for (const [targetId, o] of open) {
            const p = profileFor(targetId);
            for (const [c, since] of o.companions) {
                const rec = p.companions[c] ?? (p.companions[c] = { count: 0, ms: 0, last: 0 });
                rec.ms += Math.max(0, now - since);
                rec.last = now;
            }
            p.updated = now;
        }
        open.clear();
        // bank any in-progress game sessions too
        for (const id of [...openGame.keys()]) closeGame(id, now);
        dirty = true;
        flush();
        flushFriends(); // hours of paced fetching went into these; never drop them
        flushNames(); // names are expensive to re-fetch; never drop them on the way out
        flushIdentity(); // a rename observed and then lost is gone for good
        flushPooled(); // other contributors' findings are not ours to re-fetch
        flushRoster(); // the backlog is the point: it must survive the restart
    },
});
