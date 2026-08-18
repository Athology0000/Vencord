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

import definePlugin, { OptionType } from "@utils/types";
import { definePluginSettings } from "@api/Settings";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Menu, React, Button, Toasts } from "@webpack/common";

const settings = definePluginSettings({
    LinkPreviewURL: {
        description: "Enter image url",
        type: OptionType.STRING,
        default: "",
        async onChange() {
            processURL(settings.store.LinkPreviewURL);
        }
    },

    imageFile: {
        type: OptionType.COMPONENT,
        description: "Select a stream preview",
        component: () =>
            <Button
                color={Button.Colors.LINK}
                look={Button.Looks.FILLED}
                onClick={async () => processFile()}>
                Select a stream preview
            </Button>
    },
    imagePreview: {
        description: "imagePreview",
        type: OptionType.COMPONENT,
        default: "",
        component: () => (
            <img
                role="presentation"
                aria-hidden
                src={settings.store.imageData}
                alt=""
            />
        )
    },
    imageData: {
        description: "raw image data",
        type: OptionType.STRING,
        default: "",
    },
});
const expressionPickerPatch: NavContextMenuPatchCallback = (children, props: { target: HTMLElement; }) => {
    const { id, name, type } = props?.target?.dataset ?? {};
    const url = `https://cdn.discordapp.com/emojis/${id}.webp?size=96&quality=lossless`;

    if (!id) return;
    if (type === "emoji" && name) children.push(buildMenuItem(url));
};
const ImgContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const src = props.itemHref ?? props.itemSrc;

    if (!src) return;


    const group = findGroupChildrenByChildId("copy-link", children);
    group?.push(buildMenuItem(src));
};
function buildMenuItem(url) {
    return (
        <Menu.MenuItem
            id="stream-preview"
            key="stream-preview"
            label={`Set stream preview`}
            action={async () => {
                settings.store.LinkPreviewURL = url;
                processURL(settings.store.LinkPreviewURL);
            }
            }
        />
    );
}



export default definePlugin({
    name: "Xicord Custom Stream Preview",
    description: "Allows you to modify the image of your stream preview",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    dependencies: ["Xicord Mod Menu"],
    settings,
    contextMenus: {
        "expression-picker": expressionPickerPatch,
        "image-context": ImgContextMenuPatch,
        "message": ImgContextMenuPatch
    },
    patches: [
        {
            find: '"ApplicationStreamPreviewUploadManager"',
            replacement: {
                match: /thumbnail:([^,])/,
                replace: "thumbnail:$self.preview($1)"
            }
        },
        {
            find: '"ApplicationStreamPreviewUploadManager"',
            replacement: {
                match: /thumbnail:([^,])},o/,
                replace: "thumbnail:$self.preview($1)},o"
            }
        },
    ],
    preview(input) {
        return settings.store.imageData == "" ? input : settings.store.imageData;
    },
});

async function processFile() {
    const [file] = await DiscordNative.fileManager.openFiles({
        filters: [{ name: "Images", extensions: ["png", "jpeg", "jpg", "webp"] }]
    });

    if (!file) return;

    try {
        let blob = new Blob([file.data]);
        blob = await convertBlobToWebP(blob);
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = () => {
            settings.store.imageData = reader.result as string;
            settings.store.LinkPreviewURL = "";
            sucessfulUpdate();
        };

    } catch (_) { }
}
async function processURL(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) return;
        let blob = await response.blob();
        blob = await convertBlobToWebP(blob);
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = () => {
            settings.store.imageData = reader.result as string;
            sucessfulUpdate();
        };

    } catch (_) { }
}

async function convertBlobToWebP(blob): Promise<Blob> {
    const img = new Image();
    const url = URL.createObjectURL(blob);

    return new Promise((resolve, reject) => {
        img.onload = () => {
            URL.revokeObjectURL(url);

            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;

            const ctx = canvas.getContext('2d');
            ctx!.drawImage(img, 0, 0);

            const checkSize = (quality: number) => {
                canvas.toBlob((webpBlob) => {
                    if (webpBlob && webpBlob.size <= 200 * 1024) resolve(webpBlob);
                    else if (quality > 0.1) checkSize(quality - 0.1);
                    else resolve(webpBlob || blob);
                }, 'image/webp', quality);
            };

            checkSize(1);
        };

        img.onerror = reject;
        img.src = url;
    });
}



function sucessfulUpdate() {
    Toasts.show({
        message: `Updated stream preview`,
        id: "Updated stream preview",
        type: Toasts.Type.SUCCESS,
        options: {
            position: Toasts.Position.BOTTOM,
        }
    });
}


