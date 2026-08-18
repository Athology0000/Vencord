/*
MIT License — Copyright (c) 2026 Xicord
Shared helpers for the Xicord "watcher" plugins. Filename starts with "_" so the
plugin loader skips it (it is not a plugin, just a helper module).
*/
import { Flex } from "@components/Flex";
import { classes } from "@utils/misc";
import { ModalContent as ModalContentRaw, ModalHeader as ModalHeaderRaw, ModalRoot as ModalRootRaw, ModalSize } from "@utils/modal";
import { Button, Forms, React } from "@webpack/common";
import type { ComponentType, ReactNode } from "react";

const ModalRoot = ModalRootRaw as ComponentType<any>;
const ModalHeader = ModalHeaderRaw as ComponentType<any>;
const ModalContent = ModalContentRaw as ComponentType<any>;

export interface FeedItem { text: string; at: number; }
export interface Feed {
    push(text: string): void;
    items(): FeedItem[];
    subscribe(fn: () => void): void;
    unsubscribe(fn: () => void): void;
}

/** A small in-memory ring buffer of recent watcher events, with subscribers. */
export function feedRing(cap = 40): Feed {
    const items: FeedItem[] = [];
    const listeners = new Set<() => void>();
    return {
        push(text: string) {
            items.unshift({ text, at: Date.now() });
            if (items.length > cap) items.length = cap;
            listeners.forEach(l => { try { l(); } catch { } });
        },
        items() { return items.slice(); },
        subscribe(fn) { listeners.add(fn); },
        unsubscribe(fn) { listeners.delete(fn); },
    };
}

/** Subscribe a modal to a feed so it re-renders as events land. */
export function useWatchFeed(feed: Feed): FeedItem[] {
    const [, force] = React.useReducer(x => x + 1, 0);
    React.useEffect(() => { feed.subscribe(force); return () => feed.unsubscribe(force); }, []);
    return feed.items();
}

function timeAgo(at: number) {
    const s = Math.floor((Date.now() - at) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
}

export function WatchModalShell(props: any) {
    const { title, icon, desc, items, children, ...rest } = props;
    return (
        <ModalRoot {...rest} size={ModalSize.MEDIUM}>
            <ModalHeader>
                {icon}
                <Forms.FormTitle tag="h4" style={{ marginLeft: "10px" }}>{title}</Forms.FormTitle>
            </ModalHeader>
            <ModalContent>
                <Forms.FormText style={{ marginTop: "10px", opacity: 0.7 }}>{desc}</Forms.FormText>
                {children as ReactNode}
                <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "12px", flexDirection: "column" }}>
                    <Forms.FormTitle tag="h5" style={{ marginTop: "5px" }}>Recent</Forms.FormTitle>
                    {items && items.length
                        ? items.map((it: FeedItem, i: number) => (
                            <Flex key={i} style={{ flexDirection: "row", alignItems: "center" }}>
                                <Forms.FormText style={{ flexGrow: 1 }}>{it.text}</Forms.FormText>
                                <Forms.FormText style={{ opacity: 0.5, fontSize: 12 }}>{timeAgo(it.at)}</Forms.FormText>
                            </Flex>
                        ))
                        : <Forms.FormText>Nothing yet.</Forms.FormText>}
                </Flex>
                <Flex style={{ marginTop: "12px", marginBottom: "10px", justifyContent: "flex-end" }}>
                    <Button color={Button.Colors.GREEN} onClick={() => rest.onClose()}>Close</Button>
                </Flex>
            </ModalContent>
        </ModalRoot>
    );
}
