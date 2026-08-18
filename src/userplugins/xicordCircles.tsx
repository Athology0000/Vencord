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
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { openUserProfile } from "@utils/discord";
import { classes } from "@utils/misc";
import { ModalContent as ModalContentRaw, ModalHeader as ModalHeaderRaw, ModalRoot as ModalRootRaw, ModalSize, openModal } from "@utils/modal";
import definePlugin from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { findComponentByCodeLazy, findStoreLazy } from "@webpack";
import { Button, Forms, GuildMemberStore, GuildStore, Menu, React, UserStore } from "@webpack/common";
import type { ComponentType } from "react";

import { clickable } from "./_a11y";
import { buildFriendMap, FriendGraph, FriendRow } from "./xicordDossier";
import { MutualsAPI } from "./xicordMutuals";

const Button2 = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

const ModalRoot = ModalRootRaw as ComponentType<any>;
const ModalHeader = ModalHeaderRaw as ComponentType<any>;
const ModalContent = ModalContentRaw as ComponentType<any>;

const SelectedGuildStore = findStoreLazy("SelectedGuildStore");

// Cap how many members one modal-open will queue, so a huge server can't kick
// off hours of throttled REST scanning. Scroll + reopen to cover more.
const SCAN_CAP = 200;

// What one screenful can usefully show. Nothing here was capped, so a large scanned server
// rebuilt thousands of chips — with a user-store lookup each — on every scanner tick, and a
// member who sits in several circles was drawn once per circle. The rest are still counted
// in the "N here" total and the overflow note; they are just not all painted at once.
const CIRCLES_SHOWN = 40;
const MEMBERS_PER_CIRCLE = 24;

/**
 * Group loaded members by which of your friends they share.
 *
 * `mutualsOf(member)` returns that member's mutual friends *with you* (Discord's
 * /users/{id}/relationships), so every id it yields is already one of your friends by
 * construction — there is no need to intersect against a separate friend list. The old
 * code did exactly that intersection, so whenever RelationshipStore.getFriendIDs()
 * returned nothing (timing, an API rename) every circle was filtered away and the modal
 * showed "no connections" even though the scans had succeeded. Dropping it makes the
 * view depend only on the scan results it actually renders.
 *
 * Returns friend -> [members mutual with that friend], busiest circle first.
 */
export function buildCircles(
    memberIds: string[],
    mutualsOf: (id: string) => string[] | null,
    meId: string | undefined
): { circles: Array<[string, string[]]>; scanned: number; } {
    const circles = new Map<string, string[]>();
    let scanned = 0;
    for (const memberId of memberIds) {
        if (memberId === meId) continue;
        const mutuals = mutualsOf(memberId);
        if (mutuals == null) continue; // not scanned yet — unknown, not "no mutuals"
        scanned++;
        for (const friendId of mutuals) {
            if (friendId === meId) continue;
            const list = circles.get(friendId) ?? [];
            list.push(memberId);
            circles.set(friendId, list);
        }
    }
    const sorted = [...circles.entries()].sort((a, b) => b[1].length - a[1].length);
    return { circles: sorted, scanned };
}

/**
 * The same scan results as `buildCircles`, shaped for the Dossier's graph.
 *
 * The list above is a fan-out: one block per friend, listing everyone mutual with them.
 * It is the right shape for "who does this server know", and the wrong shape for the
 * question underneath it — a member who sits in four of your friends' circles is printed
 * four times, in four places, with nothing tying the copies together. The graph draws that
 * person once, with four edges, so the people bridging separate circles are the ones that
 * visibly stand out.
 *
 * The conversion is deliberately not its own logic: `buildFriendMap` is the sweep's own
 * row builder, and reusing it is what keeps a circle and a swept finding meaning exactly
 * the same thing — including the part that matters most, that an unscanned member is
 * PENDING (null) and never a confident "has nobody" ([]).
 */
export function circleRows(
    memberIds: string[],
    mutualsOf: (id: string) => string[] | null,
    meId: string | undefined,
    guildId: string
): FriendRow[] {
    return buildFriendMap(new Map(memberIds.map(id => [id, [guildId]])), mutualsOf, meId).rows;
}

function CirclesModal({ guildId, ...props }: RenderModalProps & { guildId: string; }) {
    // The counter is kept, not discarded: it ticks once per scanner notification, which is
    // exactly when the derived circles below can change, so it is the right memo key.
    const [scanTick, force] = React.useReducer(x => x + 1, 0);
    const [asGraph, setAsGraph] = React.useState(false);
    const mutualsRunning = MutualsAPI.isActive();

    React.useEffect(() => {
        if (!mutualsRunning) return;
        MutualsAPI.subscribe(force);
        const me = UserStore.getCurrentUser()?.id;
        const memberIds = (GuildMemberStore.getMemberIds(guildId) ?? []).filter(id => id !== me);
        // Only queue members we haven't scanned yet, and only up to the cap. Bots are
        // dropped here rather than in the scanner: it refuses them without recording
        // anything, so they never count as scanned and would silently eat cap slots
        // again on every reopen, starving the humans queued behind them.
        const toScan = memberIds
            .filter(id => !MutualsAPI.isScanned(id) && !UserStore.getUser(id)?.bot)
            .slice(0, SCAN_CAP);
        toScan.forEach(id => MutualsAPI.scan(id));
        return () => {
            MutualsAPI.unsubscribe(force);
            // Drain whatever this modal queued but the pump hasn't reached
            MutualsAPI.cancel(toScan);
        };
    }, [guildId, mutualsRunning]);

    const guild = GuildStore.getGuild(guildId);
    const me = UserStore.getCurrentUser()?.id;
    const pending = MutualsAPI.pendingCount();

    /*
     * Everything below is derived from the scan, so it is recomputed when the scan moves
     * and not on every render.
     *
     * This component subscribes `force` to the scanner, so it re-renders once per completed
     * member — up to SCAN_CAP times per open. Each of those renders used to redo the whole
     * thing: filter every loaded member with a store lookup each, walk members × their
     * mutuals in buildCircles, then walk them AGAIN in circleRows. On a large server that is
     * the entire cost of the panel, paid a couple of hundred times while you watch it.
     *
     * Keying on the scan tick also means toggling between Circles and the dossier graph —
     * the one thing you actually click in here — costs nothing.
     */
    const { memberIds, sorted, scanned } = React.useMemo(() => {
        // Bots are never scanned and you are never your own mutual, so counting them in the
        // denominator below would stop "Scanned x/y" ever reaching the end.
        const ids = (GuildMemberStore.getMemberIds(guildId) ?? [])
            .filter(id => id !== me && !UserStore.getUser(id)?.bot);
        const built = buildCircles(ids, id => MutualsAPI.getMutuals(id), me);
        return { memberIds: ids, sorted: built.circles, scanned: built.scanned };
    }, [guildId, me, scanTick]);

    // The graph rows are a SECOND full walk of members × their mutuals, and only the graph
    // view ever reads them — so they are not built while you are looking at the list.
    const rows = React.useMemo(
        () => (asGraph ? circleRows(memberIds, id => MutualsAPI.getMutuals(id), me, guildId) : []),
        [asGraph, memberIds, me, guildId, scanTick]);

    return (
        <ModalRoot {...props} size={ModalSize.LARGE}>
            <ModalHeader>
                <CirclesIcon />
                <Forms.FormTitle tag="h4" style={{ marginLeft: "10px" }}>
                    Circles in {guild?.name ?? "server"}
                </Forms.FormTitle>
            </ModalHeader>
            <ModalContent>
                {!mutualsRunning ? (
                    <Forms.FormText style={{ marginTop: "10px", color: "var(--status-warning, #f0b232)" }}>
                        Xicord Mutuals isn't running yet - restart Discord so the scanner starts, then reopen this.
                    </Forms.FormText>
                ) : (
                    <Forms.FormText style={{ marginTop: "10px", opacity: 0.7 }}>
                        Scanned {scanned}/{memberIds.length} loaded members{pending > 0 ? ` - ${pending} still queued (throttled)...` : ""}.
                        Up to {SCAN_CAP} new members are queued per open; scroll the member list and reopen to cover more.
                    </Forms.FormText>
                )}

                <Flex style={{ gap: "8px", marginTop: "10px", alignItems: "center" }}>
                    <Button size={Button.Sizes.SMALL} color={asGraph ? Button.Colors.PRIMARY : Button.Colors.BRAND}
                        onClick={() => setAsGraph(false)}>Circles</Button>
                    <Button size={Button.Sizes.SMALL} color={asGraph ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                        onClick={() => setAsGraph(true)}>Dossier graph</Button>
                </Flex>

                {asGraph ? (rows.length ? (
                    <FriendGraph rows={rows} onOpen={openUserProfile} />
                ) : (
                    <Forms.FormText style={{ marginTop: "10px", opacity: 0.7 }}>
                        Nothing to draw yet{pending > 0 ? " — still scanning" : ""}. The graph needs at
                        least one scanned member who shares a friend with you.
                    </Forms.FormText>
                )) : sorted.length !== 0 ? sorted.slice(0, CIRCLES_SHOWN).map(([friendId, members]) => {
                    const friend = UserStore.getUser(friendId);
                    return (
                        <Flex key={friendId} className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", flexDirection: "column" }}>
                            <Flex style={{ gap: "10px", flexDirection: "row", alignItems: "center" }}>
                                <img style={{ borderRadius: "50%" }} height={28} width={28} src={friend?.getAvatarURL?.()} aria-hidden="true" />
                                <Forms.FormTitle tag="h5" style={{ flexGrow: 1, margin: 0 }}>{friend?.username ?? friendId}</Forms.FormTitle>
                                <Forms.FormText style={{ opacity: 0.6 }}>{members.length} here</Forms.FormText>
                            </Flex>
                            <Flex style={{ gap: "6px", flexDirection: "row", flexWrap: "wrap", marginTop: "6px" }}>
                                {members.slice(0, MEMBERS_PER_CIRCLE).map(mid => {
                                    const m = UserStore.getUser(mid);
                                    const who = m?.username ?? mid;
                                    return (
                                        <div key={mid}
                                            {...clickable(() => openUserProfile(mid), {
                                                // `role="button"` alone announced these as buttons while
                                                // leaving them out of the tab order and deaf to Enter —
                                                // told there is a control, then unable to use it.
                                                label: `Open ${who}'s profile`,
                                                style: { display: "flex", alignItems: "center", gap: "4px", padding: "2px 6px", borderRadius: "10px", backgroundColor: "var(--background-secondary)" }
                                            })}>
                                            <img style={{ borderRadius: "50%" }} height={18} width={18} src={m?.getAvatarURL?.()} aria-hidden="true" />
                                            <span style={{ fontSize: 12 }}>{who}</span>
                                        </div>
                                    );
                                })}
                                {members.length > MEMBERS_PER_CIRCLE && (
                                    <Forms.FormText style={{ fontSize: 12, opacity: 0.6, alignSelf: "center" }}>
                                        +{members.length - MEMBERS_PER_CIRCLE} more
                                    </Forms.FormText>
                                )}
                            </Flex>
                        </Flex>
                    );
                }) : (
                    <Forms.FormText style={{ marginTop: "10px" }}>
                        No mutual-friend connections found yet{pending > 0 ? " (still scanning)" : ""}.
                    </Forms.FormText>
                )}

                <Flex style={{ marginTop: "10px", marginBottom: "10px", justifyContent: "flex-end" }}>
                    <Button color={Button.Colors.GREEN} onClick={() => props.onClose()}>Close</Button>
                </Flex>
            </ModalContent>
        </ModalRoot>
    );
}

function CirclesIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24"><g fill="#b5bac1">
            <circle cx="7" cy="9" r="4" /><circle cx="17" cy="9" r="4" opacity=".6" /><circle cx="12" cy="16" r="4" opacity=".8" />
        </g></svg>
    );
}

function openForCurrentGuild() {
    const guildId = SelectedGuildStore?.getGuildId?.();
    if (!guildId) return;
    openModal(props => <CirclesModal {...props} guildId={guildId} />);
}

function circlesButton() {
    return (
        <Button2 onClick={openForCurrentGuild} onContextMenu={openForCurrentGuild}
            role="switch" tooltipText="Xicord Circles (open in a server)"
            icon={() => <svg width="18" height="18" viewBox="0 0 24 24"><g fill="currentColor">
                <circle cx="7" cy="9" r="4" /><circle cx="17" cy="9" r="4" opacity=".6" /><circle cx="12" cy="16" r="4" opacity=".8" />
            </g></svg>} />
    );
}

function makeGuildContextMenuPatch(): NavContextMenuPatchCallback {
    return (children, props) => {
        const guildId = props?.guild?.id;
        if (!guildId) return;
        children.push(
            <Menu.MenuGroup>
                <Menu.MenuItem
                    id="xicord-circles-open"
                    label="Show Circles"
                    action={() => openModal(mprops => <CirclesModal {...mprops} guildId={guildId} />)}
                />
            </Menu.MenuGroup>
        );
    };
}

export default definePlugin({
    name: "Xicord Circles",
    description: "Maps the members of a server by which of your friends they are mutual friends with - a 'who knows who' view, as circles or as a graph",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    // Dossier for the graph: it owns the force layout, the name cache the labels come
    // from, and the "Max people" setting the graph is bounded by. Drawing this view from
    // a second copy of that machinery would be two graphs that drift apart.
    dependencies: ["Xicord Mod Menu", "Xicord Mutuals", "Xicord Dossier"],
    xicordButton: ErrorBoundary.wrap(circlesButton, { noop: true }),
    contextMenus: { "guild-context": makeGuildContextMenuPatch() },
    start() { },
    stop() { },
});
