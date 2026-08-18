/*
MIT License — Copyright (c) 2026 Xicord

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software, subject to the MIT terms. THE SOFTWARE IS PROVIDED "AS IS",
WITHOUT WARRANTY OF ANY KIND.
*/

// The dashboard snapshot used to live inside Vencord's settings.json, where it grew to
// 1.6MB — and Vencord rewrites that whole file for every unrelated setting change
// anywhere in the client, so one plugin's data was taxing everything.
//
// It can't move to IndexedDB like the Dossier's profile store did: the whole point of
// the snapshot is that a plain Node process (xicord-dashboard-server.js) reads it off
// disk, and IndexedDB lives inside Discord's leveldb. So it gets its own file next to
// settings.json instead — same directory, same readability, none of the coupling.

import { IpcMainInvokeEvent } from "electron";
import { mkdir, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";

import { SETTINGS_DIR } from "../../main/utils/constants";
import { ConnectSrc, CspPolicies } from "../../main/csp";
// The very same module the standalone dashboard server requires, bundled in here rather
// than reimplemented — two implementations of one cipher is two chances to disagree
// about a byte, and the failure mode is a file nobody can open.
import { getKey, isWindows, seal } from "../../../xicord-crypto";

// Not exported: every export of a native module must be an IPC handler.
const SNAPSHOT_FILE = join(SETTINGS_DIR, "xicord-cache.json");
const KEY_FILE = join(SETTINGS_DIR, "xicord-key.bin");

/**
 * Write the snapshot atomically: the dashboard server polls this file, and a partial
 * write would hand it truncated JSON. Writing to a temp file and renaming means a
 * reader only ever sees a whole snapshot, old or new.
 */
export async function writeSnapshot(_: IpcMainInvokeEvent, json: string): Promise<string> {
    await mkdir(dirname(SNAPSHOT_FILE), { recursive: true });
    // Sealed with the DPAPI-wrapped data key. If the key cannot be unwrapped, seal()
    // hands the plaintext straight back: an unreadable snapshot would be worse than an
    // unencrypted one, and the dashboard reports which of the two it is found.
    const body = seal(json, getKey(KEY_FILE));
    const tmp = `${SNAPSHOT_FILE}.tmp`;
    await writeFile(tmp, body, "utf-8");
    await rename(tmp, SNAPSHOT_FILE);
    return SNAPSHOT_FILE;
}

/** Whether snapshots are actually being encrypted, so the UI can say so truthfully. */
export async function encryptionStatus(_: IpcMainInvokeEvent): Promise<{ on: boolean; why: string; }> {
    if (!isWindows) return { on: false, why: "DPAPI is Windows-only; snapshots stay in plain text here" };
    return getKey(KEY_FILE)
        ? { on: true, why: "AES-256-GCM, key sealed to this Windows account with DPAPI" }
        : { on: false, why: "the key could not be created or unwrapped — see the console" };
}

/** Where the snapshot is being written, so the UI can tell the user. */
export async function snapshotPath(_: IpcMainInvokeEvent): Promise<string> {
    return SNAPSHOT_FILE;
}

// Discord's Content Security Policy blocks the renderer from reaching any host it does
// not know, so the Dossier's sync failed with a bare "Failed to fetch" — no status, no
// clue. Vencord's own comment on CspPolicies says a plugin may whitelist its own domains
// from a native script, so that is done here: this file is the only native module in the
// Xicord family, and the policy map is global, which saves restructuring the Dossier into
// a directory just to add one line.
//
// connect-src only. The sync exchanges JSON; it never loads images, styles or scripts
// from there, and granting those would widen what a compromised host could do.
CspPolicies["xicord-sync-production.up.railway.app"] = ConnectSrc;
CspPolicies["*.up.railway.app"] = ConnectSrc;

/**
 * HTTP for the sync, done from the MAIN process.
 *
 * The renderer's fetch is subject to Discord's Content Security Policy, which refuses any
 * host it does not know and reports it as a bare "Failed to fetch" — no status, no
 * reason. Whitelisting the host is possible but depends on the policy being patched
 * before the frame loads, and it failed to take here. The main process has no CSP at
 * all, so routing the request through it removes the whole class of problem rather than
 * negotiating with it.
 *
 * Returns the parsed body plus the status, so the caller can tell a 401 from a 500 —
 * which the renderer never could.
 */
export async function syncRequest(
    _: IpcMainInvokeEvent,
    url: string,
    token: string,
    body?: string
): Promise<{ status: number; body: any; }> {
    if (!/^https:\/\//.test(url)) throw new Error("sync url must be https");
    const res = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        body
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 300) }; }
    return { status: res.status, body: parsed };
}
