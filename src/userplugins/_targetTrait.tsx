/*
MIT License — Copyright (c) 2026 Xicord

The reserved "Target" trait: the single source of truth for who the Xicord
watcher family watches. Filename starts with "_" so the plugin loader skips it
(it is not a plugin, just a helper module).

Orbit resolves WatchAPI through here, so assigning the Target trait to a user in
Xicord Traits automatically subjects them to every watcher (Orbit, Profile /
Live / Post / Server / Game Watch) and Dossier.

This module talks to Xicord Traits through the settings store rather than by
importing it, the same way Xicord Watchlist reads traits. That keeps the
dependency one-way and avoids an import cycle (Traits imports Mutuals, and every
watcher imports Orbit).
*/
import { Settings, SettingsStore } from "@api/Settings";

/** Name of the reserved trait. Its row is locked in the Traits modal. */
export const TARGET_TRAIT = "Target";

const TRAITS_PLUGIN = "Xicord Traits";
const TASKS_PATH = `plugins.${TRAITS_PLUGIN}.tasks`;

interface Trait { name: string; url: string; users: string; }

/** Matched loosely so a stray "target" still drives watching rather than silently doing nothing. */
export function isTargetTrait(name: unknown): boolean {
    return typeof name === "string" && name.trim().toLowerCase() === TARGET_TRAIT.toLowerCase();
}

function rawTasks(): string {
    return (Settings.plugins[TRAITS_PLUGIN]?.tasks as string) ?? "";
}

// Deliberately does NOT drop entries this module doesn't understand: Xicord
// Mutuals keeps an auto-managed trait with extra fields in this same array, and
// every write here is a full round-trip of it. Filtering on read would silently
// delete another plugin's data on the next toggle.
function parseTraits(raw: string): Trait[] {
    try {
        const data = JSON.parse(raw || "[]");
        return Array.isArray(data) ? data : [];
    } catch { return []; }
}

const findTarget = (traits: Trait[]) => traits.find(t => isTargetTrait(t?.name));

export function readTraits(): Trait[] { return parseTraits(rawTasks()); }

function writeTraits(traits: Trait[]) {
    Settings.plugins[TRAITS_PLUGIN].tasks = JSON.stringify(traits);
}

/** Traits stores members as a "/id1/id2" string; the leading "" must be dropped. */
function splitUsers(users: unknown): string[] {
    return typeof users === "string" ? users.split("/").filter(Boolean) : [];
}

function joinUsers(ids: string[]): string {
    return ids.map(id => `/${id}`).join("");
}

// PRESENCE_UPDATES fires near-continuously, so the parse is cached and keyed on
// the raw settings string. Any writer — Orbit, the Traits modal, the Traits
// context menu — invalidates it for free, with no coordination needed.
let cachedRaw: string | null = null;
let cachedIds: string[] = [];
let cachedSet = new Set<string>();

function refresh() {
    const raw = rawTasks();
    if (raw === cachedRaw) return;
    cachedRaw = raw;
    const target = findTarget(parseTraits(raw));
    cachedIds = target ? splitUsers(target.users) : [];
    cachedSet = new Set(cachedIds);
}

/** IDs currently holding the Target trait. */
export function targetIds(): string[] {
    refresh();
    return [...cachedIds];
}

export function hasTarget(id: string): boolean {
    refresh();
    return cachedSet.has(id);
}

/** Create the Target trait if it is missing, so the row is always there to drop people into. */
export function ensureTargetTrait() {
    if (!Settings.plugins[TRAITS_PLUGIN]) return;
    const traits = readTraits();
    if (findTarget(traits)) return;
    writeTraits([...traits, { name: TARGET_TRAIT, url: "", users: "" }]);
}

/** Add or remove the Target trait for a user. Returns whether they are now targeted. */
export function toggleTarget(id: string): boolean {
    const traits = readTraits();
    let target = findTarget(traits);
    if (!target) {
        target = { name: TARGET_TRAIT, url: "", users: "" };
        traits.push(target);
    }

    const ids = splitUsers(target.users);
    const now = !ids.includes(id);
    target.users = joinUsers(now ? [...ids, id] : ids.filter(u => u !== id));
    writeTraits(traits);
    return now;
}

/** Add users to the Target trait without removing anyone (used for migration). */
export function addTargets(newIds: string[]) {
    if (!newIds.length) return;
    const traits = readTraits();
    let target = findTarget(traits);
    if (!target) {
        target = { name: TARGET_TRAIT, url: "", users: "" };
        traits.push(target);
    }
    const ids = splitUsers(target.users);
    for (const id of newIds) if (!ids.includes(id)) ids.push(id);
    target.users = joinUsers(ids);
    writeTraits(traits);
}

// Change notification. SettingsStore fires on assignment to the exact path, so
// this catches every writer regardless of which plugin made the change.
const listeners = new Set<() => void>();
let bound = false;

function onTasksChanged() {
    refresh();
    listeners.forEach(l => { try { l(); } catch { } });
}

export function subscribeTargets(fn: () => void) {
    listeners.add(fn);
    if (!bound) {
        bound = true;
        SettingsStore.addChangeListener(TASKS_PATH, onTasksChanged);
    }
}

export function unsubscribeTargets(fn: () => void) {
    listeners.delete(fn);
}
