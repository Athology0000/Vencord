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
import definePlugin, { OptionType } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { definePluginSettings } from "@api/Settings";
import { React, ContextMenuApi, Menu, Forms, Toasts } from "@webpack/common";
import { waitForStore } from "@webpack/common/internal";
import { debounce } from "@shared/debounce";
import { openUserProfile } from "@utils/discord";

let MediaEngineStore;
let Connection;
const settings = definePluginSettings({
    modifier: {
        description: "Toggles the plugin on or off",
        type: OptionType.BOOLEAN,
        default: true,
    },
    forceMono: {
        description: "forces everyone to mono",
        type: OptionType.BOOLEAN,
        default: true,
        onChange() { Connection.conn.setTransportOptions({ audioDecoders: [audioDecoder()] }); },
    },
    bitrateToggle: {
        description: "Enable custom bitrate",
        type: OptionType.BOOLEAN,
        default: true,
        onChange() { updateAudio(); },
    },
    bitrate: {
        description: "Custom bitrate of the audio (in kbps)",
        type: OptionType.NUMBER,
        default: 300,
        onChange() { updateAudio(); },
    },
    sampleRateToggle: {
        description: "Enable custom sampling frequency",
        type: OptionType.BOOLEAN,
        default: true,
        onChange() { updateAudio(); },
    },
    sampleRate: {
        description: "Custom sampling frequency of the audio (in Hz)",
        type: OptionType.NUMBER,
        default: 48000,
        onChange() { updateAudio(); },
    },
    stereo: {
        description: "Enable custom number of channels",
        type: OptionType.BOOLEAN,
        default: true,
        onChange() { updateAudio(); },

    },
    channels: {
        description: "Custom number of audio channels",
        type: OptionType.NUMBER,
        default: 4,
        onChange() { updateAudio(); },

    },
    packetSizeToggle: {
        description: "Enable custom packet size",
        type: OptionType.BOOLEAN,
        default: true,
        onChange() { updateAudio(); },

    },
    packetSize: {
        description: "Custom packet size for audio transmission (in milliseconds)",
        type: OptionType.NUMBER,
        default: 1500,
        onChange() { updateAudio(); },
    },
});
const encodingVoiceBitRate = () => {
    const rateToggle = settings.store.bitrateToggle;
    const rate = settings.store.bitrate;
    return (rateToggle && settings.store.modifier && rate ? rate : 300) * 1000;
};
const audioEncoder = () => {
    const freqToggle = settings.store.sampleRate;
    const freq = settings.store.sampleRate;
    const channelsToggle = settings.store.stereo;
    const channels = settings.store.channels;
    const rateToggle = settings.store.bitrateToggle;
    const rate = settings.store.bitrate;
    const pacsizeToggle = settings.store.packetSizeToggle;
    const pacsize = settings.store.packetSize;
    return {
        type: 120,
        name: "opus",
        freq: (freqToggle && settings.store.modifier && freq ? freq : 48000),
        channels: (channelsToggle && settings.store.modifier && channels ? channels : 1),
        rate: (rateToggle && settings.store.modifier && rate ? rate : 300) * 1000,
        pacsize: (pacsizeToggle && settings.store.modifier && pacsize ? pacsize : 960),
    };
};
const audioDecoder = () => {
    const forcesMono = settings.store.forceMono;
    return {
        channels: 2,
        freq: 48000,
        params: { stereo: forcesMono ? "0" : "1" },
        type: 120,
        name: "opus",
    };
};
const Button = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");
export default definePlugin({
    name: "Xicord Stereo",
    description: "Stereo mic options / force other users into mono",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    // Button is rendered by Xicord Mod Menu's single panel patch
    dependencies: ["Xicord Mod Menu"],
    settings,
    xicordButton: ErrorBoundary.wrap(stereoButton, { noop: true }),
    settingsAboutComponent: () => {
        return (
            <React.Fragment>
                <Forms.FormTitle tag="h3">Info</Forms.FormTitle>
                <Forms.FormText>
                    Turn off noise-suppression and echo-cancellation for the best performance
                </Forms.FormText>
            </React.Fragment>
        );
    },
    start() {
        waitForStore("MediaEngineStore", store => MediaEngineStore = store);
        const emitter = MediaEngineStore.getMediaEngine().emitter;
        emitter.on("connection", (connection) => {
            console.log(connection);
            if (connection.context === "default") {
                const updateOptions = connection.conn.setTransportOptions;
                connection.conn.setTransportOptions = function (this: any, options: Record<string, any>) {
                    for (const value in options) {
                        if (value === "encodingVoiceBitRate") options[value] = encodingVoiceBitRate();
                        else if (value === "audioEncoder") options[value] = audioEncoder();
                        else if (value === "audioDecoders") options[value][0] = audioDecoder();
                    }
                    return Reflect.apply(updateOptions, this, [options]);
                };
                Connection = connection;
            }


            let incompatible;
            if (connection?.noiseCancellation) incompatible = "Noise Suppression";
            if (connection?.echoCancellation) incompatible = "Echo Cancellation";
            if (incompatible)
                Toasts.show({
                    message: `Stereo is Incompatible with ${incompatible}`,
                    id: "Stereo",
                    type: Toasts.Type.FAILURE,
                    options: { position: Toasts.Position.BOTTOM }
                });
        });
    },
});
function stereoButton() {
    const [enabled, setEnabled] = React.useState(settings.store.modifier);
    function setEnabledValue(value: boolean) {
        setEnabled(value);
        settings.store.modifier = value;
        updateAudio();
    }
    return (
        <>
            <Button
                onClick={() => setEnabledValue(!enabled)}
                onContextMenu={e => ContextMenuApi.openContextMenu(e, () => <ContextMenu />)}
                role="switch"
                tooltipText={"Xicord Stereo"}
                icon={() =>
                    <svg width="22" height="22" viewBox="0 0 24 24">
                        <g fill={enabled ? "currentColor" : "var(--red-430)"}>
                            <path d="m24,17.769c0,1.919-1.365,3.64-3.844,4.845-.996.485-2.156-.241-2.156-1.349v-10.5c0-.767.395-1.508,1.08-1.854,1.28-.646,1.92-1.6,1.92-2.143v-.269c0-1.427-3.506-3.5-9-3.5S3,5.073,3,6.5v.269c0,.542.64,1.497,1.92,2.143.685.346,1.08,1.087,1.08,1.854v10.5c0,1.108-1.16,1.833-2.156,1.349-2.479-1.205-3.844-2.926-3.844-4.845V6.5C0,2.794,5.159,0,12,0s12,2.794,12,6.5v11.269ZM14.5,7.5c0-1.381-1.119-2.5-2.5-2.5s-2.5,1.119-2.5,2.5,1.119,2.5,2.5,2.5,2.5-1.119,2.5-2.5Zm1.5,7.5v2c0,.611-.185,1.178-.5,1.652v3.848c0,.828-.671,1.5-1.5,1.5s-1.5-.672-1.5-1.5v-2.5h-1v2.5c0,.828-.671,1.5-1.5,1.5s-1.5-.672-1.5-1.5v-3.848c-.315-.474-.5-1.042-.5-1.652v-2c0-2.206,1.794-4,4-4s4,1.794,4,4Zm-5,2.002l2-.002v-2c0-.552-.449-1-1-1s-1,.448-1,1v2.002Z" />
                        </g>
                    </svg>
                }
            />
        </>
    );
}
function updateAudio() {
    if (!Connection?.conn) return;
    Connection.conn.setTransportOptions({ audioEncoder: {}, encodingVoiceBitRate: {} });
}
function ContextMenu() {
    function useStateAndUpdateState(stateName) {
        const [state, updateState] = React.useState(settings.store[stateName]);
        function setStateAndState(value) {
            updateState(value);
            settings.store[stateName] = value;
            stateName === "forceMono" ? Connection.conn.setTransportOptions({ audioDecoders: [audioDecoder()] }) : updateAudio();
        }
        return [state, setStateAndState];
    }
    const [forceMono, updateForceMono] = useStateAndUpdateState("forceMono");
    const [bitrate, updateBitrate] = useStateAndUpdateState('bitrateToggle');
    const [frequency, updateFrequency] = useStateAndUpdateState('sampleRateToggle');
    const [stereo, updateStereo] = useStateAndUpdateState('stereo');
    const [pacsize, updatePacsize] = useStateAndUpdateState('packetSizeToggle');

    return (
        <Menu.Menu
            navId="Voice-encoder-modifier"
            aria-label="Voice encoder modifier"
            onClose={() => { }}
        >
            <Menu.MenuItem
                id="Xicord Stereo"
                label="Xicord Stereo"
                action={() => openUserProfile("1284113557201620995")}
                icon={() => {
                    return (
                        <svg
                            className={"stereo-icon"}
                            role="img"
                            width={"18"}
                            height={"18"}
                            viewBox={"0 0 24 24"}
                        >
                            <g fill={"#b5bac1"}>
                                <path d="m24,17.769c0,1.919-1.365,3.64-3.844,4.845-.996.485-2.156-.241-2.156-1.349v-10.5c0-.767.395-1.508,1.08-1.854,1.28-.646,1.92-1.6,1.92-2.143v-.269c0-1.427-3.506-3.5-9-3.5S3,5.073,3,6.5v.269c0,.542.64,1.497,1.92,2.143.685.346,1.08,1.087,1.08,1.854v10.5c0,1.108-1.16,1.833-2.156,1.349-2.479-1.205-3.844-2.926-3.844-4.845V6.5C0,2.794,5.159,0,12,0s12,2.794,12,6.5v11.269ZM14.5,7.5c0-1.381-1.119-2.5-2.5-2.5s-2.5,1.119-2.5,2.5,1.119,2.5,2.5,2.5,2.5-1.119,2.5-2.5Zm1.5,7.5v2c0,.611-.185,1.178-.5,1.652v3.848c0,.828-.671,1.5-1.5,1.5s-1.5-.672-1.5-1.5v-2.5h-1v2.5c0,.828-.671,1.5-1.5,1.5s-1.5-.672-1.5-1.5v-3.848c-.315-.474-.5-1.042-.5-1.652v-2c0-2.206,1.794-4,4-4s4,1.794,4,4Zm-5,2.002l2-.002v-2c0-.552-.449-1-1-1s-1,.448-1,1v2.002Z" />
                            </g>
                        </svg>
                    );
                }}
            />
            <Menu.MenuGroup label="VOICE DECODER MODIFIER">
                <Menu.MenuCheckboxItem
                    key="forceMono"
                    id="forceMono"
                    label="Force mono"
                    action={() => updateForceMono(!forceMono)}
                    checked={forceMono}
                />
            </Menu.MenuGroup>
            <Menu.MenuSeparator />
            <Menu.MenuGroup label="VOICE ENCODER MODIFIER">
                <Menu.MenuCheckboxItem
                    id="stereo"
                    label="Stereo"
                    checked={stereo}
                    action={() => updateStereo(!stereo)}
                />
                <Menu.MenuCheckboxItem
                    key="bitrate"
                    id="bitrate"
                    label="Bitrate"
                    action={() => updateBitrate(!bitrate)}
                    checked={bitrate}
                />
                <Menu.MenuCheckboxItem
                    id="frequency"
                    label="Sample rate"
                    checked={frequency}
                    action={() => updateFrequency(!frequency)}
                />
                <Menu.MenuCheckboxItem
                    id="pacsize"
                    label="Packet size"
                    checked={pacsize}
                    action={() => updatePacsize(!pacsize)}
                />
                <Menu.MenuSeparator />
                <Menu.MenuControlItem
                    id="Bitrate"
                    label="Bitrate"
                    control={(props, ref) => (
                        <Menu.MenuSliderControl
                            ref={ref}
                            {...props}
                            minValue={0}
                            maxValue={settings.store.bitrate > 1000 ? settings.store.bitrate : 1000}
                            value={settings.store.bitrate}
                            onChange={debounce((value: number) => {
                                updateAudio();
                                settings.store.bitrate = Number(value.toFixed(0));
                            }, 50)} renderValue={(value: number) => `${value.toFixed(0)} kbps`}
                        />
                    )}
                />
                <Menu.MenuSeparator />
                <Menu.MenuControlItem
                    id="FrequencyValue"
                    label="Sample rate"
                    control={(props, ref) => (
                        <Menu.MenuSliderControl
                            ref={ref}
                            {...props}
                            minValue={0}
                            maxValue={settings.store.sampleRate > 48000 ? settings.store.sampleRate : 48000}
                            value={settings.store.sampleRate}
                            onChange={debounce((value: number) => {
                                updateAudio();
                                settings.store.sampleRate = Number(value.toFixed(0));
                            }, 50)}
                            renderValue={(value: number) => `${value.toFixed(0)} hz`}
                        />
                    )}
                />
                <Menu.MenuSeparator />
                <Menu.MenuControlItem
                    id="pacSize"
                    label="Packet size"
                    control={(props, ref) => (
                        <Menu.MenuSliderControl
                            ref={ref}
                            {...props}
                            minValue={0}
                            maxValue={settings.store.packetSize > 3000 ? settings.store.packetSize : 3000}
                            value={settings.store.packetSize}
                            onChange={debounce((value: number) => {
                                updateAudio();
                                settings.store.packetSize = Number(value.toFixed(0));
                            }, 50)}
                            renderValue={(value: number) => `${value.toFixed(0)} bytes`}
                        />
                    )}
                />
            </Menu.MenuGroup>
        </Menu.Menu>
    );
}




