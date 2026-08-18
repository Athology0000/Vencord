/*
MIT License

Copyright (c) 2026 Xicord

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings, Settings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { classes } from "@utils/misc";
import { ModalContent as ModalContentRaw, ModalHeader as ModalHeaderRaw, ModalRoot as ModalRootRaw, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { findComponentByCodeLazy, findStoreLazy } from "@webpack";
import { Button, FluxDispatcher, Forms, Menu, React, RelationshipStore, RestAPI, TextInput, Toasts, Tooltip, UserStore } from "@webpack/common";
import type { ComponentType } from "react";

import { addTargets, subscribeTargets, TARGET_TRAIT, targetIds, toggleTarget as toggleTargetTrait, unsubscribeTargets } from "./_targetTrait";

const Button2 = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

// Same as the other Xicord plugins: the legacy modal primitives are exported as
// `never` but still render fine, so re-type them.
const ModalRoot = ModalRootRaw as ComponentType<any>;
const ModalHeader = ModalHeaderRaw as ComponentType<any>;
const ModalContent = ModalContentRaw as ComponentType<any>;

const VoiceStateStore = findStoreLazy("VoiceStateStore");
const UserProfileStore = findStoreLazy("UserProfileStore");
const QuickSwitcherStore = findStoreLazy("QuickSwitcherStore");

// Where pacing starts: the value this ran at for months, so nothing gets faster until
// Discord has actually said it is fine with it.
const FETCH_DELAY = 2500;
// The pump used to sleep a flat FETCH_DELAY and treat a 429 exactly like a success, so
// it never learned anything: a sweep of a few thousand people took hours at a speed
// nobody had measured, while a rate-limited run kept knocking at the same rate that
// earned the limit. Now the delay adapts — it eases down while Discord keeps answering
// and backs off hard the moment it objects, which is both quicker and gentler than a
// fixed guess in either direction.
const MIN_DELAY = 400;
const MAX_DELAY = 30000;
// Consecutive clean answers before easing off the brake. Small enough to converge in a
// couple of minutes, big enough that one lucky reply doesn't accelerate the whole run.
const SPEEDUP_AFTER = 5;
const SPEEDUP_FACTOR = 0.85;
const BACKOFF_FACTOR = 2;
const CACHE_TTL = 30 * 60 * 1000;
const ERROR_RETRY = 5 * 60 * 1000;
const MUTUAL_TRAIT = "Mutual";

const settings = definePluginSettings({
    targets: {
        description: `Legacy target user IDs — migrated into the "${TARGET_TRAIT}" trait`,
        type: OptionType.STRING,
        default: "[]",
        // Migrate on write too, so a Xicord Cache restore of a pre-merge backup
        // lands in the trait instead of sitting here until the next restart
        onChange() { migrateLegacyTargets(); }
    },
    hidden: {
        description: "Hidden user IDs (JSON array)",
        type: OptionType.STRING,
        default: "[]",
        onChange() { refreshHidden(); }
    },
});

function parseIds(raw: string): string[] {
    try {
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data.filter(id => typeof id === "string") : [];
    } catch { return []; }
}

// Targets ARE the shared "Target" trait: one list of people who are both watched
// by every Xicord watcher and used as the seeds for mutual-friend scanning.
const getTargets = () => targetIds();
const getHidden = () => parseIds(settings.store.hidden);

/** One-time move of the pre-merge target list into the Target trait. */
function migrateLegacyTargets() {
    const legacy = parseIds(settings.store.targets);
    if (!legacy.length) return;
    addTargets(legacy);
    settings.store.targets = "[]";
}

// True between start() and stop(). The store wrappers and settings onChange
// handlers can outlive the plugin (until a full reload), so they all check this.
let active = false;

let hiddenSet = new Set<string>();
function refreshHidden() {
    hiddenSet = new Set(getHidden());
    // Nudge the stores we filter so open UI (friends tab, quick switcher) re-renders
    try { (RelationshipStore as any).emitChange?.(); } catch { }
    try { (UserProfileStore as any).emitChange?.(); } catch { }
}

// ---------------------------------------------------------------------------
// Mutual-friends scanner
// ---------------------------------------------------------------------------

interface ScanResult {
    mutuals: string[];
    at: number;
    // A failed fetch still gets an entry, to back the retry off — but it must not be
    // mistaken for "we looked, and they have no mutual friends". Consumers ask
    // isScanned() before queueing, so without this flag one 429 would retire a user
    // permanently: they look scanned, so nobody ever asks for them again.
    failed?: boolean;
}

// Scan answers are kept ON DISK. They were memory-only, so every restart said
// "nobody has been scanned" and the whole roster — thousands of people, paced at one
// lookup a time — was re-fetched from scratch. Progress went backwards on every launch
// and a person could sit in the queue for days without ever being reached.
//
// Account-scoped, because a mutual-friend list is measured from whoever is logged in:
// one account's answers are simply wrong for another.
const RESULTS_KEY = "XicordMutualsResults";
const resultsKeyFor = (id: string | null) => (id ? `${RESULTS_KEY}:${id}` : RESULTS_KEY);
let resultsDirty = false;
let resultsTimer: any = null;
const RESULTS_FLUSH_DELAY = 20000;

function scheduleResultsFlush() {
    resultsDirty = true;
    if (resultsTimer != null) return;
    resultsTimer = setTimeout(flushResults, RESULTS_FLUSH_DELAY);
}
function flushResults() {
    if (resultsTimer != null) { clearTimeout(resultsTimer); resultsTimer = null; }
    if (!resultsDirty) return;
    resultsDirty = false;
    const key = resultsKeyFor(scannedAs);
    // A Map does not survive structured cloning into IndexedDB as an object, and the
    // failed entries are worth keeping: they carry the backoff timestamp.
    const plain: Record<string, ScanResult> = {};
    for (const [id, r] of results) plain[id] = r;
    void DataStore.set(key, plain).catch(e => {
        resultsDirty = true;
        console.error("Xicord Mutuals: scan cache save failed", e);
    });
}
async function loadResults(accountId: string | null) {
    try {
        const data = await DataStore.get(resultsKeyFor(accountId));
        if (!data || typeof data !== "object") return;
        let n = 0;
        for (const [id, r] of Object.entries(data as Record<string, ScanResult>)) {
            if (!id || !r || !Array.isArray(r.mutuals)) continue;
            results.set(id, { mutuals: r.mutuals, at: Number(r.at) || 0, failed: !!r.failed });
            n++;
        }
        if (n) { console.log(`Xicord Mutuals: restored ${n} cached scan results`); notify(); }
    } catch (e) { console.error("Xicord Mutuals: scan cache load failed", e); }
}

const results = new Map<string, ScanResult>();
const queue: string[] = [];
const queued = new Set<string>();
let currentPump: object | null = null;
const listeners = new Set<() => void>();

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function notify() {
    listeners.forEach(l => { try { l(); } catch { } });
}

function getMatched(userId: string): string[] {
    const cached = results.get(userId);
    if (!cached) return [];
    const targets = getTargets();
    return cached.mutuals.filter(id => targets.includes(id));
}

function enqueue(userId?: string, force = false) {
    if (!active || !userId) return;
    if (!force && getTargets().length === 0) return;
    if (userId === UserStore.getCurrentUser()?.id) return;
    if (UserStore.getUser(userId)?.bot) return;

    const cached = results.get(userId);
    if (cached && Date.now() - cached.at < CACHE_TTL) return;
    if (queued.has(userId)) return;

    queued.add(userId);
    queue.push(userId);
    startPump();
}

/**
 * How a request went, as far as PACING is concerned. The distinction that matters is
 * narrow: only a 429 says "you are going too fast". A 403 or a 404 is a perfectly
 * well-paced request about someone who is private or deleted, and slowing down for
 * those would punish the sweep for the shape of the server rather than for its speed.
 */
export interface Beat { rateLimited: boolean; retryAfterMs?: number; }

/**
 * Additive-decrease / multiplicative-increase on the DELAY, which is the same thing as
 * the reverse on the rate. Pure, so the policy can be tested without a network: given
 * where we are and what just happened, where should we be.
 */
export function pace(
    delay: number,
    streak: number,
    beat: Beat,
    { min = MIN_DELAY, max = MAX_DELAY, after = SPEEDUP_AFTER,
        speedup = SPEEDUP_FACTOR, backoff = BACKOFF_FACTOR } = {}
): { delay: number; streak: number; wait: number; } {
    if (beat.rateLimited) {
        // Discord's own retry_after wins when it is longer than our doubling: it knows
        // when the bucket refills and we are only guessing.
        const next = Math.min(max, Math.max(delay * backoff, beat.retryAfterMs ?? 0, min));
        // Serve the full penalty before the next request, not just the new cadence
        return { delay: next, streak: 0, wait: Math.max(next, beat.retryAfterMs ?? 0) };
    }
    const streakNow = streak + 1;
    if (streakNow < after) return { delay, streak: streakNow, wait: delay };
    const next = Math.max(min, Math.round(delay * speedup));
    return { delay: next, streak: 0, wait: next };
}

/** Pull Discord's "wait this long" out of a rejected request, in ms. */
export function retryAfterOf(e: any): number | undefined {
    // body.retry_after is seconds (often fractional); the header is seconds too
    const fromBody = e?.body?.retry_after;
    if (typeof fromBody === "number" && fromBody >= 0) return Math.round(fromBody * 1000);
    const raw = e?.headers?.["retry-after"] ?? e?.headers?.["Retry-After"];
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : undefined;
}

/** Live pacing, exposed so the sweep UI can show what speed it settled on. */
let fetchDelay = FETCH_DELAY;
let okStreak = 0;
let rateLimitHits = 0;

function startPump() {
    if (currentPump != null) return;
    const token = {};
    currentPump = token;
    void (async () => {
        try {
            while (currentPump === token) {
                const id = queue.shift();
                if (id == null) return;
                queued.delete(id);

                let mutuals: string[] | null = null;
                let beat: Beat = { rateLimited: false };
                // When this request set off. If a better answer lands while it is in
                // flight — opening the person's profile hands us one for free — that
                // newer answer must not be overwritten by this slower, redundant reply.
                const startedAt = Date.now();
                try {
                    // Mutual friends of `id`: users who are friends with both you and `id`
                    const { body } = await RestAPI.get({ url: `/users/${id}/relationships` });
                    mutuals = Array.isArray(body) ? body.map((u: any) => u?.id).filter(Boolean) : [];
                } catch (e: any) {
                    if (e?.status === 429) {
                        beat = { rateLimited: true, retryAfterMs: retryAfterOf(e) };
                        rateLimitHits++;
                        // Put them back: a 429 is not an answer about this person, and
                        // dropping them here is how a sweep quietly develops holes.
                        if (!queued.has(id)) { queued.add(id); queue.unshift(id); }
                    }
                }

                // Plugin stopped (or restarted) while the fetch was in flight
                if (currentPump !== token) return;

                if (beat.rateLimited) {
                    // Requeued above: record nothing, so they are not marked failed and
                    // then skipped for five minutes over a limit that was our fault.
                } else if (mutuals != null) {
                    const cur = results.get(id);
                    if (cur && !cur.failed && cur.at >= startedAt) {
                        // answered from somewhere else while we were waiting; leave it
                    } else {
                        results.set(id, { mutuals, at: Date.now() });
                        scheduleResultsFlush();
                        syncMutualTrait(id, getMatched(id).length > 0);
                    }
                } else {
                    // Back off on failures (429/403) instead of hammering the
                    // endpoint, but keep any known-good previous result
                    const prev = results.get(id);
                    results.set(id, {
                        mutuals: prev?.mutuals ?? [],
                        at: Date.now() - (CACHE_TTL - ERROR_RETRY),
                        failed: !prev || prev.failed
                    });
                    scheduleResultsFlush();
                }
                // Notify on failures too: a consumer showing scan progress otherwise
                // sits frozen on its opening numbers while a run of failures quietly
                // drains the queue, which reads as the feature having hung.
                notify();

                const step = pace(fetchDelay, okStreak, beat);
                fetchDelay = step.delay;
                okStreak = step.streak;
                // Space requests by their START times, not by the gap between a reply and
                // the next request. Sleeping the full delay AFTER each reply made the real
                // interval `delay + round-trip` — so a pump that had settled on 400ms was
                // actually issuing one request every ~760ms, and the adaptive search was
                // converging on "the safe rate, minus however slow the network is today".
                // Measure from the request, and the delay means what it says.
                //
                // A 429 is the exception: Discord's retry_after is measured from the
                // refusal, so that one waits in full.
                const spent = Date.now() - startedAt;
                await sleep(beat.rateLimited ? step.wait : Math.max(0, step.wait - spent));
            }
        } finally {
            if (currentPump === token) currentPump = null;
        }
    })();
}

// A mutual-friend list is "people who are friends with BOTH you and them" — it is
// measured from whoever is logged in. Cached under one account it is simply wrong for
// the next, so an account switch has to throw the whole cache away rather than serve
// the previous account's answers. Nothing watched for this before, so swapping accounts
// left every "Mutual" tag and every gold friendship ring reflecting the old login.
let scannedAs: string | null = null;

const onConnectionOpen = () => {
    if (!active) return;
    const next = UserStore.getCurrentUser()?.id ?? null;
    if (next === scannedAs) return; // a reconnect, not a switch
    // bank the outgoing account's answers under ITS key before switching
    flushResults();
    scannedAs = next;
    results.clear();
    queue.length = 0;
    queued.clear();
    currentPump = null;
    // the auto-managed trait was derived from the old account's answers
    clearManagedMutualTrait();
    notify();
    void loadResults(scannedAs).then(() => { try { syncMutualTraitAll(); } catch { } });
    scanAllVoiceStates();
};

/**
 * Read the mutual friends Discord just handed us for a freshly-opened profile.
 *
 * The list arrives as records shaped differently across builds — sometimes `{user:{id}}`,
 * sometimes `{id}`, sometimes just a key — so take whichever is there rather than
 * assuming one. An empty list is a real answer ("no mutual friends"), which is why it is
 * recorded rather than skipped; only a missing list means we learned nothing.
 */
export function profileUserId(e: any): string | null {
    // The dispatch is `{ type, userProfile: body }` and the id lives at
    // userProfile.user.id — the path the first version of this missed entirely, so it
    // bailed out on every profile and looked like the feature simply did not work.
    // USER_PROFILE_MODAL_OPEN carries a bare userId instead, hence the alternatives.
    return e?.userProfile?.user?.id ?? e?.userProfile?.userId ?? e?.userId ?? e?.user?.id ?? null;
}

const onProfileFetched = (e: any) => {
    if (!active) return;
    const id = profileUserId(e);
    if (!id || id === UserStore.getCurrentUser()?.id) return;
    try {
        const raw = (UserProfileStore as any).getMutualFriends?.(id);
        if (!Array.isArray(raw)) return;   // not loaded — not the same as "none"
        const ids = raw.map((r: any) => r?.user?.id ?? r?.id ?? r?.key).filter(Boolean);
        MutualsAPI.record(id, ids);
    } catch { }
};

function scanAllVoiceStates() {
    try {
        const all = VoiceStateStore.getAllVoiceStates() ?? {};
        for (const channelStates of Object.values(all)) {
            for (const userId of Object.keys(channelStates as object)) enqueue(userId);
        }
    } catch { }
}

const onVoiceStateUpdates = (e: any) => {
    for (const state of e?.voiceStates ?? []) {
        if (state?.channelId) enqueue(state.userId);
    }
};

function onTargetsChanged() {
    if (!active) return;
    // Cached mutual lists stay valid on target changes; only the trait needs
    // recomputing. No refetching, so this is rate-limit free.
    syncMutualTraitAll();
    scanAllVoiceStates();
    notify();
}

// The Target trait shares one settings blob with the auto-managed "Mutual" trait,
// so our OWN writes re-fire this listener. writeTraits raises `suppress` for the
// duration of a write and refreshes the key afterwards, so we never react to
// ourselves — and the key covers the Mutual members too, so a Xicord Cache
// restore that drops a stale Mutual trait in still gets reconciled.
let lastTargetKey: string | null = null;
let suppress = 0;

function currentKey() { return getTargets().join(",") + "|" + mutualTraitUsers(); }

function onTargetTraitChanged() {
    if (!active || suppress) return;
    const key = currentKey();
    if (key === lastTargetKey) return;
    lastTargetKey = key;
    onTargetsChanged();
}

// Shared scanner API for sibling Xicord plugins (e.g. Xicord Circles).
// Only works while this plugin is enabled - declare it as a dependency.
export const MutualsAPI = {
    /** Whether the scanner is running (plugin enabled AND started) */
    isActive() { return active; },
    /** Queue a mutual-friends fetch for this user (throttled + cached) */
    scan(userId: string) { enqueue(userId, true); },
    /**
     * Cached mutual-friend IDs, or null if not successfully scanned yet. A failure with
     * no earlier good result reads as null ("don't know"), never as [] ("no mutuals") —
     * otherwise a rate-limited sweep looks like a confident finding of nothing.
     */
    getMutuals(userId: string): string[] | null {
        const r = results.get(userId);
        return r && !r.failed ? r.mutuals : null;
    },
    /**
     * Whether this user has been successfully looked up. A failed fetch reports false
     * so callers keep offering them; enqueue() is what actually paces the retry, via
     * the backdated timestamp, so saying false here cannot cause a hammering loop.
     */
    isScanned(userId: string) { const r = results.get(userId); return !!r && !r.failed; },
    /**
     * Record an answer we did not have to ask for.
     *
     * Opening someone's profile makes Discord compute their mutual friends with you and
     * hand them straight to the client — the exact thing the scanner spends 2.5s a head
     * queueing for. Taking it costs nothing, jumps a person past a backlog of a thousand
     * others, and explains the complaint it was written for: "I can see the mutual on
     * their profile, so why isn't it in the list?"
     */
    record(userId: string, mutualIds: string[]) {
        if (!active || !userId) return;
        results.set(userId, { mutuals: [...new Set(mutualIds.filter(Boolean))], at: Date.now() });
        scheduleResultsFlush();
        // Drop any pending fetch for them: we have the answer, so spending a request on
        // it would be pure waste at the front of a long queue.
        if (queued.has(userId)) {
            queued.delete(userId);
            const i = queue.indexOf(userId);
            if (i >= 0) queue.splice(i, 1);
        }
        syncMutualTrait(userId, getMatched(userId).length > 0);
        notify();
    },
    /** Drop still-queued (not yet fetched) users, e.g. when a consumer UI closes */
    cancel(userIds: string[]) {
        const drop = new Set(userIds);
        for (let i = queue.length - 1; i >= 0; i--) {
            if (drop.has(queue[i])) {
                queued.delete(queue[i]);
                queue.splice(i, 1);
            }
        }
    },
    subscribe(fn: () => void) { listeners.add(fn); },
    unsubscribe(fn: () => void) { listeners.delete(fn); },
    pendingCount() { return queue.length; },
    /**
     * The cadence the pump has settled on, and how often Discord has pushed back. A
     * multi-hour sweep quoting a fixed 2.5s would be lying about its own ETA.
     */
    pacing() { return { delayMs: fetchDelay, rateLimitHits }; },
    /** Snapshot of every scanned user's mutual-friend IDs (for Xicord Cache) */
    dump(): Array<{ userId: string; mutuals: string[]; at: number; }> {
        return [...results.entries()].map(([userId, r]) => ({ userId, mutuals: r.mutuals, at: r.at }));
    },
};

// ---------------------------------------------------------------------------
// Xicord Traits sync (auto-managed "Mutual" trait)
// ---------------------------------------------------------------------------

interface trait {
    name: string;
    url: string;
    users: string;
    // Set on the auto-created "Mutual" trait so we never wipe a hand-made one.
    // Extra fields survive Xicord Traits' parse/stringify round-trips.
    managed?: boolean;
}

// Substring-safe removal: snowflakes can be prefixes of each other, so a plain
// users.replace(`/${id}`, "") could corrupt a neighbouring entry
function removeUserEntry(users: string, userId: string) {
    return users.split("/").filter(u => u && u !== userId).map(u => `/${u}`).join("");
}

function readTraits(): trait[] | null {
    const traitsPlugin = Settings.plugins["Xicord Traits"];
    if (!traitsPlugin?.enabled) return null;
    try {
        const data = JSON.parse(traitsPlugin.tasks as string || "[]");
        // null, not [] — writing back an empty array over unreadable settings
        // would delete the Target trait that every watcher depends on
        return Array.isArray(data) ? data : null;
    } catch { return null; }
}

function writeTraits(data: trait[]) {
    // Settings listeners fire synchronously, so mark this as our own write
    suppress++;
    try { Settings.plugins["Xicord Traits"].tasks = JSON.stringify(data); }
    finally { suppress--; lastTargetKey = currentKey(); }
}

function syncMutualTrait(userId: string, matched: boolean) {
    try {
        const data = readTraits();
        if (!data) return;
        let entry = data.find(t => t.name === MUTUAL_TRAIT);
        if (!entry) {
            if (!matched) return;
            entry = { name: MUTUAL_TRAIT, url: "", users: "", managed: true };
            data.push(entry);
        } else if (!entry.managed) {
            return; // hand-made trait of the same name: never touch it (as in syncMutualTraitAll)
        }
        const has = entry.users.split("/").includes(userId);
        if (matched && !has) entry.users += `/${userId}`;
        else if (!matched && has) entry.users = removeUserEntry(entry.users, userId);
        else return;
        writeTraits(data);
    } catch (e) {
        console.error("Xicord Mutuals: trait sync failed", e);
    }
}

/** Current members of the auto-managed Mutual trait, for change detection. */
function mutualTraitUsers(): string {
    const data = readTraits();
    const entry = data?.find(t => t.name === MUTUAL_TRAIT);
    return entry ? entry.users : "";
}

/**
 * Recompute the whole Mutual trait in ONE write. The old path did
 * clearManagedMutualTrait() plus a syncMutualTrait() per cached user — each a
 * separate full-settings stringify + disk IPC, so one target toggle could fire
 * hundreds of synchronous writes and re-render every subscriber each time.
 */
function syncMutualTraitAll() {
    try {
        const data = readTraits();
        if (!data) return;
        const want = [...results.keys()]
            .filter(id => getMatched(id).length > 0)
            .map(id => `/${id}`).join("");
        let entry = data.find(t => t.name === MUTUAL_TRAIT);
        if (!entry) {
            if (!want) return;
            entry = { name: MUTUAL_TRAIT, url: "", users: "", managed: true };
            data.push(entry);
        } else if (!entry.managed) {
            return; // hand-made trait of the same name: never touch it
        }
        if (entry.users === want) return;
        entry.users = want;
        writeTraits(data);
    } catch (e) {
        console.error("Xicord Mutuals: trait sync failed", e);
    }
}

function clearManagedMutualTrait() {
    try {
        const data = readTraits();
        if (!data) return;
        const entry = data.find(t => t.name === MUTUAL_TRAIT);
        if (!entry?.managed || entry.users === "") return;
        entry.users = "";
        writeTraits(data);
    } catch { }
}

// ---------------------------------------------------------------------------
// Hidden users: best-effort store filtering (restored on stop)
// ---------------------------------------------------------------------------

const unpatchers: Array<() => void> = [];

function wrapStoreMethod(obj: any, method: string, make: (orig: (...args: any[]) => any) => (...args: any[]) => any) {
    try {
        if (!obj || typeof obj[method] !== "function") return;
        const orig = obj[method].bind(obj);
        const patched = make(orig);
        obj[method] = patched;
        unpatchers.push(() => { if (obj[method] === patched) obj[method] = orig; });
    } catch { }
}

function applyHideWraps() {
    // Profile "Mutual Friends" tab
    wrapStoreMethod(UserProfileStore, "getMutualFriends", orig => (id: string) => {
        const res = orig(id);
        if (!active || !Array.isArray(res) || hiddenSet.size === 0) return res;
        return res.filter((r: any) => !hiddenSet.has(r?.user?.id ?? r?.id ?? r?.key));
    });

    // Friends tab lists (all / online / pending). Per-user checks like
    // isFriend/getRelationshipType are left untouched on purpose.
    wrapStoreMethod(RelationshipStore, "getFriendIDs", orig => () => {
        const res = orig();
        if (!active || !Array.isArray(res) || hiddenSet.size === 0) return res;
        return res.filter((id: string) => !hiddenSet.has(id));
    });
    wrapStoreMethod(RelationshipStore, "getRelationships", orig => () => {
        const res = orig();
        if (!active || !res || typeof res !== "object" || hiddenSet.size === 0) return res;
        const copy = { ...res };
        for (const id of hiddenSet) delete copy[id];
        return copy;
    });
    wrapStoreMethod(RelationshipStore, "getMutableRelationships", orig => () => {
        const res = orig();
        if (!active || !(res instanceof Map) || hiddenSet.size === 0) return res;
        const copy = new Map(res);
        for (const id of hiddenSet) copy.delete(id);
        return copy;
    });
    wrapStoreMethod(RelationshipStore, "getPendingCount", orig => () => {
        let count = orig();
        if (!active || typeof count !== "number" || hiddenSet.size === 0) return count;
        for (const id of hiddenSet) {
            // 3 = incoming friend request, the only kind counted in the badge
            if ((RelationshipStore as any).getRelationshipType?.(id) === 3) count = Math.max(0, count - 1);
        }
        return count;
    });

    // Quick switcher / "Find or start a conversation"
    wrapStoreMethod(QuickSwitcherStore, "getState", orig => () => {
        const state = orig();
        if (!active || !state?.results || hiddenSet.size === 0) return state;
        const filtered = state.results.filter((r: any) => !(r?.type === "USER" && hiddenSet.has(r?.record?.id ?? r?.id)));
        if (filtered.length === state.results.length) return state;
        return { ...state, results: filtered };
    });
}

function removeHideWraps() {
    unpatchers.forEach(un => { try { un(); } catch { } });
    unpatchers.length = 0;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function MutualTagComp({ user }: { user: any; }) {
    const [, force] = React.useReducer(x => x + 1, 0);
    React.useEffect(() => {
        listeners.add(force);
        enqueue(user?.id);
        return () => void listeners.delete(force);
    }, [user?.id]);

    if (!user) return null;
    const matched = getMatched(user.id);
    if (matched.length === 0) return null;

    const names = matched.map(id => UserStore.getUser(id)?.username ?? id).join(", ");
    return (
        <Tooltip text={`Mutual with: ${names}`}>
            {(tooltipProps: any) => (
                <span
                    {...tooltipProps}
                    style={{
                        marginLeft: 4,
                        padding: "0 4px",
                        borderRadius: 4,
                        backgroundColor: "var(--status-positive-background, #23a55a)",
                        color: "#fff",
                        flexShrink: 0,
                        display: "inline-block",
                        verticalAlign: "middle",
                        whiteSpace: "nowrap",
                        // The tag is spliced in as a sibling of the username text, so
                        // every inheritable text property leaks in from it — a themed or
                        // custom username font, italics, uppercasing, letter-spacing or a
                        // glow would all be copied onto the tag. Pin them all.
                        fontFamily: "var(--font-display, var(--font-primary, sans-serif))",
                        fontSize: 10,
                        fontWeight: 700,
                        lineHeight: "14px",
                        fontStyle: "normal",
                        fontVariant: "normal",
                        letterSpacing: "normal",
                        wordSpacing: "normal",
                        textTransform: "none",
                        textDecoration: "none",
                        textShadow: "none",
                    }}
                >
                    Mutual
                </span>
            )}
        </Tooltip>
    );
}

function toggleTarget(id: string) {
    // Writes the shared Target trait, so this also puts them on (or off) the
    // watch list that every Xicord watcher reads
    if (toggleTargetTrait(id) && !(RelationshipStore as any).isFriend?.(id)) {
        Toasts.show({
            message: "Target added, but they can only match once they're on your friends list",
            id: "xicord-mutuals-nonfriend",
            type: Toasts.Type.MESSAGE,
            options: { position: Toasts.Position.BOTTOM }
        });
    }
    // onTargetsChanged runs via the Target trait's change listener
}

function toggleHidden(id: string) {
    const hidden = getHidden();
    if (hidden.includes(id)) settings.store.hidden = JSON.stringify(hidden.filter(h => h !== id));
    else settings.store.hidden = JSON.stringify([...hidden, id]);
    // refreshHidden runs via the setting's onChange handler
}

function MenuItems(id: string) {
    const [, force] = React.useReducer(x => x + 1, 0);
    return (
        <>
            <Menu.MenuCheckboxItem
                id="xicord-mutual-target"
                label="Mutual Target"
                checked={getTargets().includes(id)}
                action={() => { toggleTarget(id); force(); }}
            />
            <Menu.MenuCheckboxItem
                id="xicord-hide-user"
                label="Hide User"
                checked={getHidden().includes(id)}
                action={() => { toggleHidden(id); force(); }}
            />
        </>
    );
}

function makeContextMenuPatch(): NavContextMenuPatchCallback {
    return (children, props) => {
        if (!props?.user?.id) return;
        if (props.user.id === UserStore.getCurrentUser()?.id) return;
        children.splice(-1, 0, <Menu.MenuGroup>{MenuItems(props.user.id)}</Menu.MenuGroup>);
    };
}

function UserRow({ id, onRemove, warnNonFriend }: { id: string; onRemove: () => void; warnNonFriend?: boolean; }) {
    const user = UserStore.getUser(id);
    const nonFriend = warnNonFriend && !(RelationshipStore as any).isFriend?.(id);
    return (
        <Flex style={{ gap: "10px", flexDirection: "row", flex: "none", alignItems: "center", marginLeft: "0px", marginRight: "0px" }}>
            <img
                style={{ borderRadius: "50%" }}
                aria-hidden="true"
                height={28}
                width={28}
                src={user?.getAvatarURL() ?? "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQSuV3pnrrgeSNYPADFteFSiKUUFgD-04hYBA&s"}
            />
            <Forms.FormText style={{ flexGrow: 1 }}>{user?.username ?? id}</Forms.FormText>
            {nonFriend ? (
                <Tooltip text="Not on your friends list - they can never show as a mutual">
                    {(tooltipProps: any) => (
                        <span {...tooltipProps} style={{ color: "var(--status-warning, #f0b232)", fontSize: 16 }}>⚠</span>
                    )}
                </Tooltip>
            ) : null}
            <Button2
                onClick={onRemove}
                role="switch"
                tooltipText={"Remove"}
                icon={() =>
                    <svg role="img" width="18" height="18" viewBox="0 0 24 24">
                        <g fill={"var(--red-430)"}>
                            <path d="M14.25 1c.41 0 .75.34.75.75V3h5.25c.41 0 .75.34.75.75v.5c0 .41-.34.75-.75.75H3.75A.75.75 0 0 1 3 4.25v-.5c0-.41.34-.75.75-.75H9V1.75c0-.41.34-.75.75-.75h4.5Z" />
                            <path fillRule="evenodd" d="M5.06 7a1 1 0 0 0-1 1.06l.76 12.13a3 3 0 0 0 3 2.81h8.36a3 3 0 0 0 3-2.81l.75-12.13a1 1 0 0 0-1-1.06H5.07ZM11 12a1 1 0 1 0-2 0v6a1 1 0 1 0 2 0v-6Zm3-1a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Z" />
                        </g>
                    </svg>
                }
            />
        </Flex>
    );
}

function IdListEditor({ title, note, placeholder, ids, onAdd, onRemove, warnNonFriend }: {
    title: string;
    note?: string;
    placeholder: string;
    ids: string[];
    onAdd: (id: string) => void;
    onRemove: (id: string) => void;
    warnNonFriend?: boolean;
}) {
    const [newId, setNewId] = React.useState("");
    return (
        <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", marginBottom: "10px", justifyContent: "space-around", flexDirection: "column" }}>
            <Forms.FormTitle tag="h5" style={{ marginTop: "5px" }}>{title}</Forms.FormTitle>
            {note ? <Forms.FormText style={{ opacity: 0.6, fontSize: 12, marginBottom: "4px" }}>{note}</Forms.FormText> : null}
            <Flex style={{ gap: "20px", flexDirection: "row", flex: "none", alignItems: "center" }}>
                <Flex style={{ flexGrow: 1, flexDirection: "column", marginLeft: "0px", marginRight: "0px" }}>
                    <TextInput
                        value={newId}
                        placeholder={placeholder}
                        onChange={(e: string) => setNewId(e)}
                    />
                </Flex>
                <Button2
                    onClick={() => {
                        const id = newId.trim();
                        if (!/^\d{5,}$/.test(id)) {
                            Toasts.show({
                                message: "Enter a valid user ID",
                                id: "xicord-mutuals-bad-id",
                                type: Toasts.Type.FAILURE,
                                options: { position: Toasts.Position.BOTTOM }
                            });
                            return;
                        }
                        if (!ids.includes(id)) onAdd(id);
                        setNewId("");
                    }}
                    role="switch"
                    tooltipText={"Add"}
                    icon={() =>
                        <svg width="18" height="18" viewBox="0 0 24 24">
                            <g fill={"#b5bac1"}>
                                <path d="M17,12c0,.553-.448,1-1,1h-3v3c0,.553-.448,1-1,1s-1-.447-1-1v-3h-3c-.552,0-1-.447-1-1s.448-1,1-1h3v-3c0-.553,.448-1,1-1s1,.447,1,1v3h3c.552,0,1,.447,1,1Zm7-7v14c0,2.757-2.243,5-5,5H5c-2.757,0-5-2.243-5-5V5C0,2.243,2.243,0,5,0h14c2.757,0,5,2.243,5,5Zm-2,0c0-1.654-1.346-3-3-3H5c-1.654,0-3,1.346-3,3v14c0,1.654,1.346,3,3,3h14c1.654,0,3-1.346,3-3V5Z" />
                            </g>
                        </svg>
                    }
                />
            </Flex>
            {ids.length !== 0
                ? ids.map(id => <UserRow key={id} id={id} onRemove={() => onRemove(id)} warnNonFriend={warnNonFriend} />)
                : <Forms.FormText style={{ marginBottom: "5px" }}>Empty - right-click a user to add them</Forms.FormText>}
        </Flex>
    );
}

export function MutualsSection() {
    const [, force] = React.useReducer(x => x + 1, 0);
    return (
        <>
            <IdListEditor
                title={`Targets — "${TARGET_TRAIT}" trait`}
                note={`One shared list: everyone here is watched by every Xicord watcher and used as a seed for mutual-friend scanning. Same list as the "${TARGET_TRAIT}" trait in Xicord Traits and "Watch User" in the right-click menu.`}
                placeholder="Add target by user ID"
                ids={getTargets()}
                onAdd={id => { toggleTarget(id); force(); }}
                onRemove={id => { toggleTarget(id); force(); }}
                warnNonFriend={true}
            />
            <IdListEditor
                title="Hidden Users"
                placeholder="Hide a user by ID"
                ids={getHidden()}
                onAdd={id => { toggleHidden(id); force(); }}
                onRemove={id => { toggleHidden(id); force(); }}
            />
        </>
    );
}

function MutualsModal(props: RenderModalProps) {
    return (
        <ModalRoot {...props} size={ModalSize.LARGE}>
            <ModalHeader>
                <MutualsIcon />
                <Forms.FormTitle tag="h4" style={{ marginLeft: "10px" }}>Xicord Mutuals</Forms.FormTitle>
            </ModalHeader>
            <ModalContent>
                <MutualsSection />
                <Flex style={{ marginTop: "10px", marginBottom: "10px", justifyContent: "flex-end" }}>
                    <Button color={Button.Colors.GREEN} onClick={() => props.onClose()}>Close</Button>
                </Flex>
            </ModalContent>
        </ModalRoot>
    );
}

function MutualsIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24">
            <g fill={"#b5bac1"}>
                <path d="M14 8.00598C14 10.211 12.206 12.006 10 12.006C7.795 12.006 6 10.211 6 8.00598C6 5.80098 7.794 4.00598 10 4.00598C12.206 4.00598 14 5.80098 14 8.00598ZM2 19.006C2 15.473 5.29 13.006 10 13.006C14.711 13.006 18 15.473 18 19.006V20.006H2V19.006Z" />
                <path d="M14.5 12.006C16.985 12.006 19 9.99098 19 7.50598C19 5.02098 16.985 3.00598 14.5 3.00598C14.108 3.00598 13.735 3.06898 13.375 3.16298C14.383 4.45698 15 6.05798 15 7.80598C15 9.28998 14.55 10.669 13.788 11.827C14.021 11.930 14.255 12.006 14.5 12.006Z" opacity=".6" />
                <path d="M15.976 13.483C17.802 14.792 19 16.708 19 19.006V20.006H22V19.006C22 16.269 19.516 14.216 15.976 13.483Z" opacity=".6" />
            </g>
        </svg>
    );
}

function mutualsButton() {
    return (
        <Button2
            onClick={() => openModal(props => <MutualsModal {...props} />)}
            onContextMenu={() => openModal(props => <MutualsModal {...props} />)}
            role="switch"
            tooltipText={"Xicord Mutuals"}
            icon={() =>
                <svg width="18" height="18" viewBox="0 0 24 24">
                    <g fill={"currentColor"}>
                        <path d="M14 8.00598C14 10.211 12.206 12.006 10 12.006C7.795 12.006 6 10.211 6 8.00598C6 5.80098 7.794 4.00598 10 4.00598C12.206 4.00598 14 5.80098 14 8.00598ZM2 19.006C2 15.473 5.29 13.006 10 13.006C14.711 13.006 18 15.473 18 19.006V20.006H2V19.006Z" />
                        <path d="M14.5 12.006C16.985 12.006 19 9.99098 19 7.50598C19 5.02098 16.985 3.00598 14.5 3.00598C14.108 3.00598 13.735 3.06898 13.375 3.16298C14.383 4.45698 15 6.05798 15 7.80598C15 9.28998 14.55 10.669 13.788 11.827C14.021 11.930 14.255 12.006 14.5 12.006Z" opacity=".6" />
                        <path d="M15.976 13.483C17.802 14.792 19 16.708 19 19.006V20.006H22V19.006C22 16.269 19.516 14.216 15.976 13.483Z" opacity=".6" />
                    </g>
                </svg>
            }
        />
    );
}

export default definePlugin({
    name: "Xicord Mutuals",
    description: "Tags people in voice channels who share your targets as mutual friends, and hides selected users from search, friends lists and mutual-friends views",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    dependencies: ["Xicord Mod Menu", "Xicord Traits"],
    settings,
    xicordButton: ErrorBoundary.wrap(mutualsButton, { noop: true }),
    contextMenus: {
        "user-context": makeContextMenuPatch(),
    },
    // Fires on login and on every account switch
    flux: {
        CONNECTION_OPEN: onConnectionOpen,
        // Discord has just computed this person's mutual friends with you server-side.
        // Take the free answer rather than queueing them behind a thousand others.
        // Both events: the fetch carries the profile body, the modal only a userId, and
        // which one fires depends on whether the profile was already cached.
        USER_PROFILE_FETCH_SUCCESS: onProfileFetched,
        USER_PROFILE_MODAL_OPEN: onProfileFetched,
    },
    patches: [
        // Voice channel user rows: append the Mutual tag after the username,
        // same module roleColorEverywhere patches (VoiceUser)
        {
            find: "#{intl::GUEST_NAME_SUFFIX})]",
            replacement: {
                match: /(#{intl::GUEST_NAME_SUFFIX}.{0,50}?"")\](?<=user:(\i).+?)/,
                replace: "$1,$self.MutualTag({user:$2})]"
            }
        }
    ],
    MutualTag: (props: { user: any; }) => (
        <ErrorBoundary noop>
            <MutualTagComp {...props} />
        </ErrorBoundary>
    ),
    start() {
        active = true;
        // Remember which account the cache belongs to, so the first CONNECTION_OPEN
        // after a normal start is recognised as a reconnect rather than a switch
        scannedAs = UserStore.getCurrentUser()?.id ?? null;
        // Restore what we already know before anything queues: without this every
        // launch re-asks about everyone and the sweep never gets past the same names.
        void loadResults(scannedAs).then(() => { try { syncMutualTraitAll(); } catch { } });
        // Migrate before subscribing so the migration's own write doesn't
        // immediately re-enter onTargetsChanged
        migrateLegacyTargets();
        lastTargetKey = currentKey();
        subscribeTargets(onTargetTraitChanged);
        refreshHidden();
        applyHideWraps();
        // The trait is auto-managed: rebuild it from whatever the in-memory cache
        // already knows (survives disable/enable without refetching) in a single
        // write, then let the scanner fill in the rest
        syncMutualTraitAll();
        FluxDispatcher.subscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
        scanAllVoiceStates();
    },
    stop() {
        active = false;
        unsubscribeTargets(onTargetTraitChanged);
        lastTargetKey = null;
        FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
        removeHideWraps();
        currentPump = null;
        queue.length = 0;
        queued.clear();
        // Don't leave Xicord Traits alerting on entries we no longer manage
        clearManagedMutualTrait();
        flushResults(); // hours of paced fetching; never drop it on the way out
    },
});
