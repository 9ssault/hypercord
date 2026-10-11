# Addon sources

The client's built-in browser can list and open the plugin and theme catalogues published by other Discord client projects. The machine-readable list lives in [`addon-sources.json`](../addon-sources.json) and `core/sources.js` reads it; this page is the same thing for a person. Sixty entries.

Every URL in that file was fetched when it was written, and what it *returns* is recorded in the entry rather than assumed. Discord add-ons are decentralised: there is no single catalogue of all of them, and one author's repository, one client's proxy and one community index are three different things. The list is deliberately wider than it is useful - it includes projects that are archived, discontinued, or whose index URL is gone - because a browser that silently shows nothing for a source that moved is worse than one that says why.

## Read this before promising anyone an install

Fetchable is not installable. This client executes one documented dialect - the `.txt`/`.js data-only addons in [`addon-framework.md`](addon-framework.md) - and it refuses general JavaScript by design. So:

* an Aliucord, Vendetta, Bunny, Revenge, Kettu, ShiggyCord, Enmity, Vencord, Equicord, BetterDiscord or Replugged plugin **cannot be installed here**, whoever wrote it;
* an Aliucord, Catppuccin or BetterDiscord **theme** is a different file format from this client's theme records, which accept only the ten documented color tokens;
* what the browser is for is finding things, reading about them, and opening the source page - the list is a map, not a compatibility claim.

Nothing is fetched automatically and nothing is fetched on a timer. A catalogue is read when a person asks for it.

## What a program can actually read

These return JSON that parses without scraping. Everything under `api.github.com` is unauthenticated and rate-limited, which is recorded in each entry.

| Source | URL | Returns |
| --- | --- | --- |
| Aliucord plugin manifest | `https://plugins.aliucord.com/manifest.json` | Array of plugins: name, version, metadata, ZIP artifact URL. The best single Android source. |
| Revenge community catalogue | `https://revenge-mod.github.io/revenge-community-plugins/index.json` | Plugin id, version, channel, artifact URL and SHA-256 digest per entry. Themes are plugins in this ecosystem, so one list covers both. Raw mirror: `.../raw.githubusercontent.com/revenge-mod/revenge-community-plugins/gh-pages/index.json`. |
| Vendetta proxy list (legacy) | `https://raw.githubusercontent.com/vd-plugins/proxy/trunk/plugins.json` | Array of plugin URL strings. `plugins-full.json` is the same list with metadata objects. |
| Bunny proxy list (legacy) | `https://raw.githubusercontent.com/bn-plugins/vd-proxy/trunk/plugins.json` | Same shape as Vendetta's, with some Bunny-patched entries. Bunny is archived. |
| Equicord metadata | `https://raw.githubusercontent.com/Equicord/Equibuilds/main/plugins.json` | Generated metadata for Equicord's combined catalogue; `equicordplugins.json` and `vencordplugins.json` are its two halves. Metadata and source paths, no artifacts. |
| Vencord plugin readmes | `https://raw.githubusercontent.com/Vencord/builds/main/plugin-readmes.json` | Plugin name to README text. Descriptions, no download URLs. |
| GitHub directory and org listings | `https://api.github.com/repos/Aliucord/plugins/contents`, `.../repos/Vencord/contents/src/plugins?ref=main`, `.../repos/revenge-mod/revenge-community-plugins/contents/`, `.../branches?per_page=100`, `.../orgs/Aliucord/repos?per_page=100`, `.../orgs/revenge-mod/repos?per_page=100`, `.../orgs/BetterDiscord/repos?per_page=100`, `.../repos/catppuccin/aliucord/git/trees/main?recursive=1`, `.../repos/Purple-EyeZ/Plugins-List/git/trees/main?recursive=1` | Directory, branch and organisation listings of a known repository. Rate-limited, and they only enumerate repositories someone already named - they discover nothing on their own. The org endpoints show what a project owns, not what third-party authors published in it. |
| Per-plugin manifest | `https://rico040.github.io/bunny-plugins/hideappbutton/manifest.json` | A fetched example of one author publishing `manifest.json` beside a single plugin, which is also the shape of a hand-added source URL. |
| Revenge plugin format | `https://raw.githubusercontent.com/revenge-mod/revenge-plugin-template/main/README.md` | Prose, not JSON, but the best description anywhere of what a Revenge-compatible `index.json` contains: artifact URLs and checksums for `plugins/<name>/` on a gh-pages branch. |

Of the sixty entries, twenty-one are honestly machine-readable: the ones above. The rest are marked `machine_readable: false` on purpose, so a browser that lists them opens them for a person rather than pretending to have parsed them.

## Pages, not catalogues

BetterDiscord's [plugin](https://betterdiscord.app/plugins) and [theme](https://betterdiscord.app/themes) listings, Replugged's [store](https://replugged.dev/store/plugins), [Vendetta's browser](https://vd-plugins.github.io/web/), Bunny's [fork of it](https://bn-plugins.github.io/vd-web/), the community [Revenge Plugins List](https://plugins-list.pages.dev/), [Vencord's plugin page](https://vencord.dev/plugins), [Equicord's theme library](https://themes.equicord.org/) and Aliucord's [themes page](https://aliucord.com/themes) are rendered pages. They are worth opening in the built-in browser and worthless to parse; no raw index for them was verified. The Revenge Plugins List is not affiliated with Revenge, and Nexpid's author-maintained list is a page too - its apparent `index.json` returned 404, which is exactly the kind of assumption this list exists to avoid.

There is also a class of source that has to be read as a person: the GitHub repository and organisation pages ([DiscordStyles](https://github.com/DiscordStyles), [Kettu](https://github.com/C0C0B01/Kettu), [Nexpid's plugins](https://github.com/nexpid/RevengePlugins), Rico040's [Bunny-patched list](https://github.com/Rico040/bunny-plugins), [ShiggyCord](https://github.com/kmmiio99o/ShiggyCord), D3SOX's [unmaintained userplugins](https://github.com/D3SOX/vencord-userplugins)) and the GitHub topic tags ([Vencord](https://github.com/topics/vencord-plugins), [BetterDiscord plugins](https://github.com/topics/betterdiscord-plugins), [themes](https://github.com/topics/betterdiscord-theme)). Topic tags are applied unevenly by authors, so they are discovery only - never a complete catalogue.

[Enmity](https://github.com/enmity-mod/enmity) on iOS is in the list for completeness, and one of its pages says outright that it does **not** work inside Discord's built-in browser - which is recorded in that entry, because a client that opens it and sees nothing should know why.

## Dead ends, kept on purpose

Three entries are recorded as `404` because the URL was fetched and is gone: Aliucord's old `plugins-repo-old/tree/builds` branch and the commonly assumed `DiscordStyles/ThemeRepo` and `DiscordStyles/PluginRepo` repositories. They stay in the catalogue so the browser can say a source is missing instead of showing an empty list that looks like an empty ecosystem. The same reason keeps the archived projects in: [Pyoncord](https://github.com/pyoncord) (archived 2025-08-07), Bunny, and Vendetta, which was discontinued in 2024.

Themes are the thinnest area everywhere. Aliucord has no official theme index and its themes page is view-only, so the closest thing is a directory listing of one community repository ([catppuccin/aliucord](https://api.github.com/repos/catppuccin/aliucord/git/trees/main?recursive=1)) whose files are individual JSON themes; [catppuccin/vendetta](https://github.com/catppuccin/vendetta) covers Bunny, Revenge and Enmity. Equicord's theme library is a website. BetterDiscord and Replugged themes are arbitrary CSS URLs hosted by their authors. There is no theme index to fetch, and the browser should say so rather than show an empty list that looks broken.

## On the device

`core/sources.js` is the copy this list is delivered as, because the bundled React Native code cannot read the JSON out of the app package. It offers the same entries through `globalThis.__ASSAULT_ADDONS__.sources` as `all`, `byId`, `forKind`, `byPlatform`, `fetchPlan` and `unfetchableReason`. `fetchPlan` returns a URL, a `parse` mode (`list`, `metadata`, `tree`) and the format for anything a program may fetch, and `null` for everything else; `unfetchableReason` turns that `null` into one sentence - including "is gone: the URL returned 404 when it was checked" for the dead ends above.

## Adding a source

Add an entry to [`addon-sources.json`](../addon-sources.json) **and** the same entry to `core/sources.js`: a stable lowercase `id`, a `name`, the `platform` (`android`, `ios` or `desktop`) and `kinds`, the fetched `url`, its `format` (`json-list`, `json-metadata`, `github-tree`, `directory`, `web-page` or `404`), whether it is `machine_readable`, and a `notes` line stating what it returns and whether the project is still maintained. Fetch the URL before adding it - a guessed URL is the one failure mode a catalogue of other people's repositories cannot afford. The two files are meant to be identical; a diff of `id`, `url`, `format` and `machine_readable` between them should come out empty.
