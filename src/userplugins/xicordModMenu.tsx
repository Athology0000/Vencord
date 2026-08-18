/*
MIT License

Copyright (c) 2024 Xicord

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
import ErrorBoundary from "@components/ErrorBoundary";
import { Button, Forms, React, Switch as SwitchRaw, Slider, TextInput, Select, TabBar, Tooltip, UserStore } from "@webpack/common";
import { Flex } from "@components/Flex";
import { Card } from "@components/Card";
import { ModalContent as ModalContentRaw, ModalFooter as ModalFooterRaw, ModalHeader as ModalHeaderRaw, ModalRoot as ModalRootRaw, openModal, ModalSize, } from "@utils/modal";
import type { RenderModalProps } from "@vencord/discord-types";
import type { ComponentType, JSX } from "react";
import { definePluginSettings, Settings } from "@api/Settings";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { debounce } from "@shared/debounce";
import { classes } from "@utils/misc";
import { findByPropsLazy, findComponentByCodeLazy } from "@webpack";
import { ApplicationCommandInputType } from "@api/Commands";
import Plugins from "~plugins";
import { Margins } from "@utils/margins";
import { PluginCard } from "@components/settings/tabs/plugins/PluginCard";
import { ChangeList } from "@utils/ChangeList";
import { openUserProfile } from "@utils/discord";
import { addProfileBadge, BadgePosition, BadgeUserArgs, ProfileBadge, removeProfileBadge } from "@api/Badges";
import { addMessageDecoration, removeMessageDecoration } from "@api/MessageDecorations";
import { addMemberListDecorator, removeMemberListDecorator } from "@api/MemberListDecorators";

import { classNameFactory } from "@api/Styles";

import { clickable } from "./_a11y";
const cl = classNameFactory("vc-plugins-");
const Button2 = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

// Vencord exports these as `never` to push new code towards the current Modal /
// FormSwitch / Divider components. They still render, so re-type them here rather
// than rewrite this whole multi-tab modal against the new API.
const ModalRoot = ModalRootRaw as ComponentType<any>;
const ModalHeader = ModalHeaderRaw as ComponentType<any>;
const ModalContent = ModalContentRaw as ComponentType<any>;
const ModalFooter = ModalFooterRaw as ComponentType<any>;
const Switch = SwitchRaw as ComponentType<any>;
const FormDivider = Forms.FormDivider as ComponentType<any>;


let accountArea: HTMLElement;
let statusArea: HTMLElement;
let iconArea: HTMLElement;
let flexArea: HTMLElement;
let styleArea: HTMLElement;

let badges;
let badgedUsers;

const badge: ProfileBadge = {
    id: "xicord-badges",
    description: "Xicord Badges",
    position: BadgePosition.START,
    getBadges
};

function ReloadRequiredCard({ required }: { required: boolean; }) {
    return (
        <>
            {required ? (<Card className={cl("info-card", { "restart-card": required })} style={{ marginTop: "10px" }}>

                <>
                    <Forms.FormTitle tag="h5">Restart required!</Forms.FormTitle>
                    <Forms.FormText className={cl("dep-text")}>
                        Restart to apply changes
                    </Forms.FormText>
                    <Button color={Button.Colors.RED} onClick={() => location.reload()}>
                        Restart
                    </Button>
                </>
            </Card>) : (null)}
        </>
    );
}

const layouts = [
    { label: "classic", value: 0, default: false },
    { label: "layout 1", value: 1, default: true },
    { label: "layout 2", value: 2, default: false },
    { label: "layout 3", value: 3, default: false },
];

const tabs = [
    { name: "Icons", value: 0, default: true },
    { name: "Settings", value: 1, default: false },
    { name: "Info", value: 2, default: false },
];
const enum SearchStatus {
    ALL,
    ENABLED,
    DISABLED,
}

const settings = definePluginSettings({
    statusSize: {
        description: "Sets the size of the status area",
        type: OptionType.SLIDER,
        markers: makeRange(0, 100, 10),
        default: 40,
        stickToMarkers: false,
    },
    iconsPerRow: {
        description: "Sets the numbers of icons rendered on each row",
        type: OptionType.SLIDER,
        markers: makeRange(1, 6, 1),
        default: 5,
        stickToMarkers: true,
    },
    layout: {
        description: "select a layout",
        type: OptionType.SELECT,
        options: [...layouts],
    },
    IconData: {
        description: "Object for icon data",
        type: OptionType.STRING,
        default: ""
    },
    badgeData: {
        description: 'Local badge data, e.g. {"badges":{"cool":{"tip":"Cool person","icon":"https://example.com/badge.png"}},"users":{"1234567890":["cool"]}}',
        type: OptionType.STRING,
        default: "",
        onChange() { loadBadges(); }
    },
});
function managerButton() {
    return (
        <>
            <Button2
                onClick={() => openModal(props => <EncModals {...props} />)}
                onContextMenu={() => openModal(props => <EncModals {...props} />)}
                role="switch"
                tooltipText={"Xicord Mod Menu"}
                icon={() =>
                    <svg width="18" height="18" viewBox="0 0 24 24">
                        <g fill={"currentColor"}>
                            <path d="M22,14c0,.552-.447,1-1,1H9c-.552,0-1-.448-1-1s.448-1,1-1h12c.553,0,1,.448,1,1ZM5,12H3c-.552,0-1,.448-1,1v2c0,.552,.448,1,1,1h2c.552,0,1-.448,1-1v-2c0-.552-.448-1-1-1Zm16,7H9c-.552,0-1,.448-1,1s.448,1,1,1h12c.553,0,1-.448,1-1s-.447-1-1-1Zm-16-1H3c-.552,0-1,.448-1,1v2c0,.552,.448,1,1,1h2c.552,0,1-.448,1-1v-2c0-.552-.448-1-1-1ZM24,3.5v3c0,1.933-1.567,3.5-3.5,3.5H3.5c-1.933,0-3.5-1.567-3.5-3.5V3.5C0,1.567,1.567,0,3.5,0H20.5c1.933,0,3.5,1.567,3.5,3.5Zm-4.886,0h-4.257c-.697,0-1.043,.846-.546,1.334l1.858,1.825c.455,.455,1.177,.455,1.632,0l1.858-1.825c.498-.489,.152-1.334-.546-1.334Z" />
                        </g>
                    </svg >
                }
            />
        </>
    );
}

function EncModals(props: RenderModalProps) {

    const query = iconArea?.querySelectorAll('[aria-label*="Xicord" i]') ?? [];
    const iconState = Array.from(query) as HTMLElement[];
    if (!isValidJson(settings.store.IconData)) updateIconPosition();

    const newIconsState = iconState.map(icons => ({
        name: icons.getAttribute('aria-label'),
        enabled: icons.style?.display !== "none",
        position: JSON.parse(settings.store.IconData).find(item => item.name === icons.getAttribute('aria-label'))?.position ?? 0
    }));

    const [searchValue, setSearchValue] = React.useState({ value: "", status: SearchStatus.ALL });
    const onSearch = (query: string) => setSearchValue(prev => ({ ...prev, value: query }));
    const onStatusChange = (status: SearchStatus) => setSearchValue(prev => ({ ...prev, status }));
    const [icons, setIcons] = React.useState(newIconsState);
    const [, setLayout] = React.useState(settings.store.layout);
    const [tab, setTab] = React.useState(tabs[0]);
    const [, setUpdate] = React.useState(0);

    const updateIconState = (name, display) => {
        const updatedIcons = [...icons];
        const index = updatedIcons.findIndex(icon => icon.name === name);
        if (index !== -1) {
            updatedIcons[index].enabled = display;
            setIcons(updatedIcons);
        }
        iconState[index].style.display = display ? 'block' : 'none';
    };
    const reorderIcons = (name, direction = 'up') => {
        const elements = Array.from(iconArea.querySelectorAll('[aria-label="' + name + '"]'));

        if (elements.length > 0) {
            elements.forEach(element => {
                if (direction === "up") {
                    let previousElement = element.previousElementSibling;
                    if (previousElement) previousElement.before(element);
                } else {
                    let nextElement = element.nextElementSibling;
                    if (nextElement) nextElement.after(element);
                }
            });
        }
        updateIconPosition();
    };
    const getSvg = (name) => {

        let svgElement = iconState.find((element) => element.ariaLabel === name) as Element;
        svgElement = svgElement.children[0].children[0];
        const getAttributeOrUndefined = (attr: string) => svgElement.getAttribute(attr) || undefined;

        let svgHtml = svgElement.outerHTML;

        svgHtml = svgHtml.replace(/fill="[^"]*"/, 'fill="#b5bac1"');


        return (
            <svg
                style={{ scale: "1.75", transform: " translateY(10px)" }}
                viewBox={getAttributeOrUndefined('viewBox')}
                width={getAttributeOrUndefined('width')}
                height={getAttributeOrUndefined('height')}
                dangerouslySetInnerHTML={{ __html: svgHtml }}
            />
        );
    };
    const moveItemByName = (items, itemName, direction = 'up') => {
        const index = items.findIndex(item => item.name === itemName);
        if (index === -1) return items;

        const newIndex = direction === 'up' ? index - 1 : index + 1;
        if (newIndex < 0 || newIndex >= items.length) return items;

        [items[index], items[newIndex]] = [items[newIndex], items[index]];

        return items;
    };


    const middleIndex = Math.ceil(icons.length / 2);
    const sortedPlugins = React.useMemo(() => {
        const pluginsContainingXicord = Object.values(Plugins).filter(plugin => plugin?.name?.toLowerCase().includes('xicord'));
        return pluginsContainingXicord.sort((a, b) => a.name.localeCompare(b.name));
    }, []);

    // Lower-cased once per keystroke instead of twice per plugin inside the filter loop.
    const searchQuery = searchValue.value.toLocaleLowerCase();

    const changes = React.useMemo(() => new ChangeList<string>(), []);

    return (
        <ModalRoot {...props} size={ModalSize.LARGE}>
            <ModalHeader>
                <svg width="20" height="20" viewBox="0 0 24 24" style={{ marginRight: "10px" }}>
                    <g fill={"#b5bac1"}>
                        <path d="M22,14c0,.552-.447,1-1,1H9c-.552,0-1-.448-1-1s.448-1,1-1h12c.553,0,1,.448,1,1ZM5,12H3c-.552,0-1,.448-1,1v2c0,.552,.448,1,1,1h2c.552,0,1-.448,1-1v-2c0-.552-.448-1-1-1Zm16,7H9c-.552,0-1,.448-1,1s.448,1,1,1h12c.553,0,1-.448,1-1s-.447-1-1-1Zm-16-1H3c-.552,0-1,.448-1,1v2c0,.552,.448,1,1,1h2c.552,0,1-.448,1-1v-2c0-.552-.448-1-1-1ZM24,3.5v3c0,1.933-1.567,3.5-3.5,3.5H3.5c-1.933,0-3.5-1.567-3.5-3.5V3.5C0,1.567,1.567,0,3.5,0H20.5c1.933,0,3.5,1.567,3.5,3.5Zm-4.886,0h-4.257c-.697,0-1.043,.846-.546,1.334l1.858,1.825c.455,.455,1.177,.455,1.632,0l1.858-1.825c.498-.489,.152-1.334-.546-1.334Z" />
                    </g>
                </svg>
                <Forms.FormTitle tag="h4"> Xicord Mod Menu</Forms.FormTitle>
            </ModalHeader>

            <ModalContent>

                <div style={{ marginTop: "10px" }}>
                    <TabBar
                        type="top"
                        look="brand"
                        selectedItem={tab.value}
                        onItemSelect={(id: number) => setTab(tabs.find(t => t.value === id) ?? tabs[0])}
                    >
                        {tabs.map(t => (
                            <TabBar.Item key={t.value} id={t.value}>
                                {t.name}
                            </TabBar.Item>
                        ))}
                    </TabBar>
                </div>

                {tab.value === 0 ?
                    (<>
                        <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px" }}>
                            <Flex flexDirection="row" style={{ marginTop: "10px", marginBottom: "10px", justifyContent: "space-around", }}>
                                <Flex style={{ justifyContent: "space-around", flexDirection: "column", width: "50%" }}>
                                    <Forms.FormTitle tag="h5" style={{ marginTop: "10px" }}>Icons per row</Forms.FormTitle>
                                    <Slider
                                        disabled={false}
                                        markers={makeRange(1, 6, 1)}
                                        minValue={1}
                                        maxValue={6}
                                        initialValue={settings.store.iconsPerRow}
                                        onValueChange={debounce((value: number) => {
                                            settings.store.iconsPerRow = Number(value.toFixed(0));
                                            if (iconArea) iconArea.style.gridTemplateColumns = `repeat(${value.toFixed(0)}, 1fr)`;

                                        }, 0)}
                                        onValueRender={v => (v).toFixed(0)}
                                        onMarkerRender={v => (v)}
                                        stickToMarkers={true}
                                    />
                                </Flex>
                                <Flex style={{ justifyContent: "space-around", flexDirection: "column", width: "50%" }}>
                                    <Forms.FormTitle tag="h5" style={{ marginTop: "10px" }}>Icon layout</Forms.FormTitle>
                                    <div>
                                        <Select
                                            //@ts-ignore
                                            multi={true}
                                            options={layouts}
                                            serialize={String}
                                            select={(e) => {
                                                settings.store.layout = e;
                                                updateLayout();
                                                setLayout(e);
                                            }}
                                            isSelected={v => v === settings.store.layout}
                                            closeOnSelect={true}
                                        />
                                    </div>
                                </Flex>
                            </Flex>
                        </Flex>
                        <FormDivider style={{ marginTop: "10px", marginBottom: "10px" }} />
                        <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", marginBottom: "10px", justifyContent: "space-around", flexDirection: "column" }}>
                            <Forms.FormTitle tag="h5" style={{ marginTop: "10px" }}>Enabled icons</Forms.FormTitle>
                            <Flex flexDirection="row" style={{ margin: "10px", justifyContent: "space-around", }}>
                                {[icons.slice(0, middleIndex), icons.slice(middleIndex)].map((array, column) => (
                                    <Flex key={column} style={{ gap: "10px", flexDirection: "column", width: "50%" }}>
                                        {array.map((icon) => (
                                            // Keyed by name, not index: the reorder buttons move icons around
                                            // and index keys would leave Switch state on the wrong row.
                                            <React.Fragment key={String(icon.name)}>
                                                <Flex style={{ gap: "20px", flexDirection: "row", flex: "none", marginRight: "10px", marginLeft: "10px" }}>

                                                    {getSvg(icon.name)}
                                                    <Switch
                                                        style={{ width: "100%" }}

                                                        value={icon.enabled}
                                                        onChange={(e: boolean) => {
                                                            updateIconState(icon.name, e);
                                                            settings.store.IconData = JSON.stringify(icons);
                                                            getSvg(icon.name);
                                                        }}
                                                    >
                                                        {icon.name}
                                                    </Switch>


                                                    <Flex style={{ gap: "10px", flexDirection: "column", marginLeft: "0px" }}>

                                                        <Tooltip text={"Move Up"}>
                                                            {({ onMouseLeave, onMouseEnter }) => (
                                                                <div
                                                                    onMouseLeave={onMouseLeave}
                                                                    onMouseEnter={onMouseEnter}
                                                                    {...clickable(() => {
                                                                        setIcons([...moveItemByName(icons, icon.name, 'up')]);
                                                                        reorderIcons(icon.name, 'up');
                                                                    }, {
                                                                        // The tooltip is a hover affordance; it gives this control no name
                                                                        // when you cannot hover. These arrows are the only way to reorder
                                                                        // the header icons, so they have to be reachable and announced.
                                                                        label: `Move ${icon.name} up`,
                                                                        style: {
                                                                            borderRadius: "75%",
                                                                            backgroundColor: "var(--background-secondary)",
                                                                            display: "inline-flex",
                                                                            justifyContent: "center",
                                                                            alignItems: "center",
                                                                            width: "16px",
                                                                            height: "16px",
                                                                        }
                                                                    })}
                                                                >
                                                                    <svg width="9" height="9" viewBox="0 0 24 24" style={{ transform: "rotate(180deg)" }} aria-hidden="true">
                                                                        <g fill={"#b5bac1"}>
                                                                            <path d="M6.41,9H17.59a1,1,0,0,1,.7,1.71l-5.58,5.58a1,1,0,0,1-1.42,0L5.71,10.71A1,1,0,0,1,6.41,9Z" />
                                                                        </g>
                                                                    </svg>
                                                                </div>
                                                            )}
                                                        </Tooltip>
                                                        <Tooltip text={"Move down"}>
                                                            {({ onMouseLeave, onMouseEnter }) => (
                                                                <div
                                                                    onMouseLeave={onMouseLeave}
                                                                    onMouseEnter={onMouseEnter}
                                                                    {...clickable(() => {
                                                                        setIcons([...moveItemByName(icons, icon.name, 'down')]);
                                                                        reorderIcons(icon.name, 'down');
                                                                    }, {
                                                                        label: `Move ${icon.name} down`,
                                                                        style: {
                                                                            borderRadius: "75%",
                                                                            backgroundColor: "var(--background-secondary)",
                                                                            display: "inline-flex",
                                                                            justifyContent: "center",
                                                                            alignItems: "center",
                                                                            width: "16px",
                                                                            height: "16px",
                                                                        }
                                                                    })}
                                                                >
                                                                    <svg width="9" height="9" viewBox="0 0 24 24" aria-hidden="true">
                                                                        <g fill={"#b5bac1"}>
                                                                            <path d="M6.41,9H17.59a1,1,0,0,1,.7,1.71l-5.58,5.58a1,1,0,0,1-1.42,0L5.71,10.71A1,1,0,0,1,6.41,9Z" />
                                                                        </g>
                                                                    </svg>
                                                                </div>
                                                            )}
                                                        </Tooltip>
                                                    </Flex>
                                                </Flex>
                                            </React.Fragment>
                                        ))}
                                    </Flex>
                                ))}
                            </Flex>
                        </Flex>
                    </>) : (null)}

                {tab.value === 1 ? (

                    <>
                        <ReloadRequiredCard required={changes.hasChanges} />

                        <div style={{ marginTop: "20px", }} className={classes(Margins.bottom20, cl("filter-controls"))}>
                            <TextInput autoFocus value={searchValue.value} placeholder="Search for a plugin..." onChange={onSearch} />
                            <div>
                                <Select
                                    options={[
                                        { label: "Show All", value: SearchStatus.ALL, default: true },
                                        { label: "Show Enabled", value: SearchStatus.ENABLED },
                                        { label: "Show Disabled", value: SearchStatus.DISABLED },
                                    ]}
                                    serialize={String}
                                    select={onStatusChange}
                                    isSelected={v => v === searchValue.status}
                                    closeOnSelect={true}

                                />
                            </div>
                        </div>

                        <div style={{ marginBottom: "20px", }} className={cl("grid")}>
                            {sortedPlugins.map(plugin => {

                                const settings = Settings.plugins[plugin.name];

                                const isEnabled = () => settings.enabled ?? false;


                                let validFilter = false;
                                let validState = false;

                                // `query` is lower-cased once outside this loop rather than twice per
                                // plugin: with ~150 plugins that was ~600 throwaway strings on every
                                // keystroke, for a value that is the same for all of them.
                                if (plugin.name.toLocaleLowerCase().includes(searchQuery)) validFilter = true;
                                if (plugin.description.toLocaleLowerCase().includes(searchQuery)) validFilter = true;

                                if ((searchValue.status === SearchStatus.ALL) || (isEnabled() && searchValue.status === SearchStatus.ENABLED) || (!isEnabled() && searchValue.status === SearchStatus.DISABLED)) validState = true;

                                if (!(validFilter && validState)) return (null);



                                return (
                                    <Flex
                                        key={plugin.name}
                                        className={classes("qualitySettingsContainer__8f353")}
                                        onClick={() => {
                                            setUpdate(Math.floor(Math.random() * 10000));
                                        }}
                                    >
                                        <PluginCard
                                            onRestartNeeded={name => {
                                                changes.handleChange(name);
                                            }}
                                            disabled={plugin.name === "Xicord Mod Menu"}
                                            plugin={plugin}
                                            isNew={false}
                                            key={plugin.name}
                                        />
                                    </Flex>

                                );
                            }
                            )}
                        </div>
                    </>) : (null)}

                {tab.value === 2 ? (
                    <>
                        <Flex style={{ gap: "10px", flexDirection: "row", flex: "none", alignItems: "center" }}>

                            <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", justifyContent: "space", flexDirection: "column" }}>

                                <Forms.FormTitle tag="h5" style={{ marginTop: "10px", }}>Important</Forms.FormTitle>

                                <Flex style={{ justifyContent: "space", gap: "15px", flexDirection: "column", marginLeft: "0px", }}>
                                    <Forms.FormText>- Xicord plugins are maintained regularly </Forms.FormText>
                                    <Forms.FormText>- You can support the developer by inviting them to the support server</Forms.FormText>
                                    <Forms.FormText>- Check the server for plugin updates</Forms.FormText>
                                </Flex>
                            </Flex>

                            <Tooltip text={(UserStore.getUser("1284113557201620995")?.username ?? "Xicord")}>
                                {({ onMouseLeave, onMouseEnter }) => (
                                    <div
                                        onMouseLeave={onMouseLeave}
                                        onMouseEnter={onMouseEnter}
                                        role="button"
                                        aria-label={(UserStore.getUser("1284113557201620995")?.username ?? "Xicord")}
                                        style={{
                                            borderRadius: "50%",
                                            backgroundColor: "var(--background-secondary)",
                                            display: "inline-flex",
                                            justifyContent: "center",
                                            alignItems: "center",
                                            width: "7.5em",
                                            height: "7.5em",

                                        }}
                                        onClick={() => {
                                            openUserProfile("1284113557201620995");
                                        }}
                                    >
                                        <img
                                            aria-hidden
                                            style={{
                                                borderRadius: "50%",
                                                width: "100%",
                                                height: "100%",
                                            }}
                                            src={UserStore.getUser("1284113557201620995")?.getAvatarURL()}
                                            alt={(UserStore.getUser("1284113557201620995")?.username ?? "Xicord")}
                                        />
                                    </div>
                                )}
                            </Tooltip>
                        </Flex>





                        <Flex style={{ gap: "10px", flexDirection: "row", flex: "none", marginBottom: "10px" }}>
                            <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", justifyContent: "space", flexDirection: "column", marginRight: "0px", marginLeft: "0px" }}>

                                <Forms.FormTitle tag="h5" style={{ marginTop: "10px", }}>Updating Plugins</Forms.FormTitle>


                                <Flex style={{ justifyContent: "space-around", gap: "15px", flexDirection: "column", marginLeft: "0px" }}>
                                    <Forms.FormText>Drag the new plugin into your plugins folder</Forms.FormText>
                                    <Forms.FormText>Open a terminal in the vencord directory</Forms.FormText>
                                    <Forms.FormText>Run "pnpm build"</Forms.FormText>
                                </Flex>
                            </Flex>

                            <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", justifyContent: "space", flexDirection: "column", marginRight: "0px", marginLeft: "0px" }}>

                                <Forms.FormTitle tag="h5" style={{ marginTop: "10px" }}>tips</Forms.FormTitle>

                                <Flex style={{ justifyContent: "space", gap: "10px", flexDirection: "column", marginLeft: "0px" }}>
                                    <Flex style={{ gap: "10px", flexDirection: "row", flex: "none", alignItems: "center", }}>
                                        <Forms.FormText>You can open the mod menu with</Forms.FormText>

                                        <div className={classes("combo_c90023")}>
                                            <span className={classes("key_c90023")}>alt</span>
                                            <span className={classes("key_c90023")}>x</span>
                                        </div>
                                    </Flex>
                                    <Flex style={{ flexDirection: "row", flex: "none", alignItems: "center", marginLeft: "0px" }}>
                                        <Forms.FormText>You can join the </Forms.FormText>
                                        <Button
                                            {...props}
                                            style={{ padding: "0px", marginLeft: "5px" }}
                                            look={Button.Looks.LINK}
                                            color={Button.Colors.LINK}
                                            onClick={() => VencordNative.native.openExternal("https://discord.gg/BDeZ7dyf3y")}
                                        >Support Server 🧻
                                        </Button>
                                    </Flex>
                                    <Forms.FormText>If you find any errors lemme know</Forms.FormText>


                                </Flex>
                            </Flex>
                        </Flex>
                    </>) : (null)}
            </ModalContent>

            <ModalFooter>
                <Button
                    color={Button.Colors.RED}
                    onClick={() => {
                        props.onClose();
                    }}
                >
                    Close
                </Button>
            </ModalFooter>
        </ModalRoot >

    );
}
function updateLayout() {
    // Discord's class names change between updates; these areas may not be found
    if (!accountArea || !statusArea || !flexArea) return;

    switch (settings.store.layout) {
        case 0: {
            accountArea.style.minWidth = "125px";
            statusArea.style.display = "inline";
            flexArea.style.display = "";
            flexArea.style.alignItems + "flex-start";
            flexArea.style.flexDirection = "";


            break;
        }
        case 1: {
            accountArea.style.minWidth = "auto";
            statusArea.style.display = "none";
            flexArea.style.display = "";
            flexArea.style.alignItems + "flex-start";
            flexArea.style.flexDirection = "";

            break;
        }
        case 2: {
            accountArea.style.minWidth = "100%";
            statusArea.style.display = "inline";
            flexArea.style.display = "flex";
            flexArea.style.flexDirection = "column-reverse";
            flexArea.style.alignItems + "flex-start";

            break;
        }
        case 3: {
            accountArea.style.minWidth = "100%";
            statusArea.style.display = "inline";
            flexArea.style.display = "grid";
            flexArea.style.gridTemplateColumns = "repeat(1, 1fr)";

            break;
        }
    }

}
function keybind(e) {
    if (e.altKey && e.key.toLowerCase() === 'x') {
        findIcons();
        openModal(props => <EncModals {...props} />);
    }
}
function findIcons() {
    iconArea = document.querySelector('.container_b2ca13 > :nth-child(2)') as HTMLElement;
    statusArea = document.querySelector('.nameTag_b2ca13.canCopy_b2ca13') as HTMLElement;
    accountArea = document.querySelector('.avatarWrapper_b2ca13') as HTMLElement;
    flexArea = document.querySelector('.container_b2ca13') as HTMLElement;
    styleArea = document.querySelector('.container_b2ca13 ') as HTMLElement;

    if (styleArea && iconArea) {
        styleArea.style.height = "auto";
        styleArea.style.paddingTop = "10px";
        styleArea.style.paddingBottom = "10px";
        styleArea.style.height = "auto";
        styleArea.style.height = "auto";
        styleArea.style.height = "auto";

        iconArea.style.display = 'grid';
        iconArea.style.gridTemplateColumns = `repeat(${settings.store.iconsPerRow}, 1fr)`;
        iconArea.style.gap = '0';
        iconArea.style.height = '100%';
        iconArea.style.width = '100%';
        iconArea.style.boxSizing = 'border-box';
        iconArea.style.justifyItems = 'center';
    }

    updateLayout();
}
const updateIconPosition = () => {
    if (!iconArea) return;
    const query = iconArea.querySelectorAll('[aria-label*="Xicord" i]');
    const iconState = Array.from(query) as HTMLElement[];
    const data = iconState.map(icons => ({
        name: icons.getAttribute('aria-label'),
        enabled: icons.style?.display !== "none",
        position: iconState.findIndex((item) => item.ariaLabel === icons.getAttribute('aria-label'))
    }));
    settings.store.IconData = JSON.stringify(data);
};

function isValidJson(data: string): boolean | [] {
    try {
        JSON.parse(data); return true;
    } catch (e) { return false; }
}
function loadBadges() {
    try {
        const data = JSON.parse(settings.store.badgeData || "{}");
        badges = data.badges ?? {};
        badgedUsers = data.users ?? {};
    } catch (error) {
        console.error(`Xicord Mod Menu: invalid badgeData JSON: ${(error as Error).message}`);
        badges = {};
        badgedUsers = {};
    }
}
function getBadges({ userId }: BadgeUserArgs): ProfileBadge[] {
    const user = UserStore.getUser(userId);
    if (!user || user.bot) return [];

    if (!userId) return [];
    if (!badgedUsers) return [];
    let badgedUser = Object.keys(badgedUsers).find(id => id === userId);


    if (!badgedUser) return [];
    badgedUser = badgedUsers[badgedUser];

    interface badgeData {
        tip: string;
        icon: string;
    }


    const hasBadges: badgeData[] = Object.keys(badges)
        .filter(badgeName => badgedUser?.includes(badgeName))
        .map(badgeName => badges[badgeName]);


    const icons = hasBadges.map(badge => (
        <Vc key={badge.tip} tip={badge.tip} icon={badge.icon} />
    ));

    return [{
        id: "xicord-badges",
        key: "xicord-badges",
        description: "Xicord Badges",
        component: () => (
            <span className="Xicord-mod-menu">
                {icons}
            </span>
        )
    }];
}
const indicatorLocations = {
    list: {
        onEnable: () => addMemberListDecorator("Xicord-badges", props =>
            <ErrorBoundary noop>
                <VcIcon user={props.user} small={true} />
            </ErrorBoundary>
        ),
        onDisable: () => removeMemberListDecorator("Xicord-badges")
    },
    badges: {
        description: "In user profiles, as badges",
        onEnable: () => addProfileBadge(badge),
        onDisable: () => removeProfileBadge(badge)
    },
    messages: {
        onEnable: () => addMessageDecoration("Xicord-badges", props =>
            <ErrorBoundary noop>
                <VcIcon user={props.message?.author} wantTopMargin={true} />
            </ErrorBoundary>
        ),
        onDisable: () => removeMessageDecoration("Xicord-badges")
    }
};
function VcIcon({ user, wantMargin = true, wantTopMargin = false, small = false }): JSX.Element | null {
    if (!user) return null;
    if (!badgedUsers) return null;
    let badgedUser = Object.keys(badgedUsers).find(id => id === user.id);

    if (!badgedUser) return null;
    badgedUser = badgedUsers[badgedUser];

    interface badgeData {
        tip: string;
        icon: string;
    }

    const hasBadges: badgeData[] = Object.keys(badges)
        .filter(badgeName => badgedUser?.includes(badgeName))
        .map(badgeName => badges[badgeName]);


    const icons = hasBadges.map(badge => (
        <Vc key={badge.tip} tip={badge.tip} icon={badge.icon} />
    ));


    return (
        <span
            className="vc-platform-indicator"
            style={{
                marginLeft: wantMargin ? 4 : 0,
                top: wantTopMargin ? 2 : 0,
                gap: 2
            }}
        >

            {icons}
        </span>
    );
}
function Vc({ tip, icon }) {
    return <Tooltip text={tip} color={Tooltip.Colors.PRIMARY} >
        {(tooltipProps: any) => (
            <div
                onClick={(e) => {
                }}
                onContextMenu={e => {
                }}
            >
                <img
                    {...tooltipProps}
                    height={19}
                    width={19}
                    src={icon}
                />
            </div>
        )}
    </Tooltip>;
}

export default definePlugin({
    name: "Xicord Mod Menu",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    description: "A mod menu for Xicord' plugins",
    commands: [
        {
            name: "Mod Menu",
            description: "Open Xicord Mod Menu",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (opts, ctx) => { openModal(props => <EncModals {...props} />); },
        },
    ],
    settings,
    managerButton: ErrorBoundary.wrap(managerButton, { noop: true }),
    patches: [
        {
            // Insert as a row in the panels stack (above the account panel) instead of
            // inline with the mic/deafen buttons, which overflows the row
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            replacement: {
                match: /children:\[(?=.{0,500}?accountContainerRef)/,
                replace: "children:[$self.xicordButtons(),",
            },
        },
    ],
    // Renders the buttons of every enabled Xicord plugin. A single patch site avoids
    // the four plugins fighting over the same injection point.
    xicordButtons: ErrorBoundary.wrap(() => {
        // Auto-discovery: any enabled Xicord plugin exposing a `xicordButton` render
        // function gets its button placed here. Sorted by name so the order is stable
        // across restarts rather than depending on plugin registry order.
        const buttons = Object.values(Plugins)
            .filter(p => p?.name?.startsWith("Xicord") && p.name !== "Xicord Mod Menu")
            .filter(p => Settings.plugins[p.name]?.enabled)
            .filter(p => typeof (p as any).xicordButton === "function")
            .sort((a, b) => a.name.localeCompare(b.name));

        return (
            <div className="xicord-button-row" style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", alignItems: "center", columnGap: "12px", rowGap: "8px", padding: "4px 8px" }}>
                {managerButton()}
                {buttons.map(p => (
                    <React.Fragment key={p.name}>{(p as any).xicordButton()}</React.Fragment>
                ))}
            </div>
        );
    }, { noop: true }),
    async start() {
        loadBadges();
        document.addEventListener('keydown', keybind);

        document.head.appendChild(document.createElement('style')).textContent = `
  .Xicord-mod-menu {
        display: inline-flex;
        justify-content: center;
        align-items: center;
        vertical-align: top;
        position: relative;
  }
`;
        let checkAttempts = 0;
        const checkExist = setInterval(() => {
            // Discord's class hashes change between updates; bail out instead of polling forever
            if (++checkAttempts > 300) return clearInterval(checkExist);
            findIcons();
            if (flexArea && accountArea && statusArea && iconArea && styleArea) {

                if (settings.store.IconData === "") updateIconPosition();

                setTimeout(function () {
                    const array = JSON.parse(settings.store.IconData).sort((a, b) => a.position - b.position);
                    array.reverse().forEach((obj) => {
                        const elements = Array.from(iconArea.querySelectorAll('[aria-label="' + obj.name + '"]')) as any;
                        if (elements.length > 0) {
                            const elementToMove = elements[0];
                            iconArea.prepend(elementToMove);
                        }
                        if (!obj.enabled) elements[0].style.display = "none";
                    });

                }, 200);
                clearInterval(checkExist);
            }
        }, 100);
        Object.entries(indicatorLocations).forEach(([key, value]) => {
            value.onEnable();
        });

    },
    stop() {
        document.removeEventListener('keydown', keybind);
        Object.entries(indicatorLocations).forEach(([_, value]) => {
            value.onDisable();
        });
    }
});


