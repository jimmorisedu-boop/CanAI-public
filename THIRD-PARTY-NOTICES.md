# Third-party components and licenses

CanAI uses open-source libraries and fonts. Each component retains its own
license and attribution terms. This file lists the components most relevant to
the application and includes the applicable license text. A reproducible
inventory of production dependencies, together with their own LICENSE/NOTICE
files, is in `THIRD-PARTY-LICENSES.txt` and is refreshed by `npm run licenses`.

## Selected libraries (MIT license)

| Component | Copyright holder |
|---|---|
| [React](https://react.dev), react-dom | © Meta Platforms, Inc. and affiliates |
| [Konva](https://konvajs.org) | © Anton Lavrenov |
| [react-konva](https://github.com/konvajs/react-konva) | © Anton Lavrenov |
| [@xyflow/react (React Flow)](https://reactflow.dev) | © webkid GmbH |
| Express and other server dependencies | See `server/node_modules/*/LICENSE` |

### MIT license text

The MIT license is the same for the packages listed above; only the copyright
line changes:

```
MIT License

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
```

## Fonts (SIL Open Font License 1.1)

The interface uses **Onest** for UI text, **JetBrains Mono** for technical
text, and **Manrope** in legacy bundled assets. The bundled files are
`client/public/fonts/onest-*.woff2`, `client/public/fonts/jetbrains-mono-*.woff2`,
and `client/public/fonts/manrope-*.woff2`.

| Font | Copyright | License text |
|---|---|---|
| Onest | © 2021 The Onest Project Authors | `client/public/fonts/OFL-Onest.txt` |
| JetBrains Mono | © 2020 The JetBrains Mono Project Authors | `client/public/fonts/OFL-JetBrains-Mono.txt` |
| Manrope | © 2018 The Manrope Project Authors | `client/public/fonts/OFL.txt` |

The OFL permits fonts to be bundled, embedded, redistributed, and sold with
software, but the font software itself may not be sold by itself. Keep the
copyright notice and the corresponding OFL text with redistributed font files.

## FFmpeg and LAME (LGPL) — video and audio processing

Trimming, cropping, track extraction, cut detection, and waveform generation
use **FFmpeg**. On Windows, CanAI downloads the pinned LGPL build from the
Settings screen. The **macOS distribution includes a build** in
`runtime/media-tools/`, produced by `scripts/build-ffmpeg-macos.sh`.

The project packages intentionally use the pinned LGPL-only FFmpeg build. The
FFmpeg and LAME components keep their separate licenses and attribution terms.
For FFmpeg's legal information, see https://ffmpeg.org/legal.html.

| Component | Version | License | Source |
|---|---|---|---|
| [FFmpeg](https://ffmpeg.org) | 8.1.2 | LGPL 2.1+ | https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz |
| [LAME](https://lame.sourceforge.io) | 3.100 | LGPL (Library GPL v2) | https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz |

SHA-256 checksums for the archives used:

```
464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c  ffmpeg-8.1.2.tar.xz
ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e  lame-3.100.tar.gz
```

**Why this build.** The macOS build is produced from the pinned sources with
the project configuration below. It intentionally does not rely on a build
whose component terms differ from the pinned LGPL-only package. Other
components, including face-comparison packages, retain their own terms and are
not covered by this notice.

**Build configuration.** The binary uses neither `--enable-gpl` nor
`--enable-nonfree`, x264, or x265. LAME is the only external library; FFmpeg
uses it for MP3 encoding needed by **Separate audio**. Video is encoded by
`h264_videotoolbox`, which is part of macOS rather than a third-party component.
You can inspect the binary directly:

```
runtime/media-tools/ffmpeg -version   # configuration line
runtime/media-tools/ffmpeg -L         # license reported by the binary
```

**LAME attribution.** The LAME license asks for this attribution: CanAI uses
the LAME encoder; the project website is https://lame.sourceforge.io.

**Source code.** The LGPL requires a way to rebuild and replace the library in
the product. The exact versions, source addresses, and checksums are listed
above, and `scripts/build-ffmpeg-macos.sh` is the recipe used for the bundled
file. Component sources are available on request.

Full license texts are in `licenses/`:
`ffmpeg-LGPL-2.1.txt`, `lame-LGPL-2.txt`, `lame-LICENSE.txt`.

## Screenshot sample photos

The README screenshots use real cat photographs with example text cards added
on the Canvas. These photos are sample references, not AI-generated results.

| Photo | Author | Source | Terms |
|---|---|---|---|
| Red tabby looking down at camera | Roc0ast3r | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Red_tabby_looking_down_at_camera.jpg) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Kitten sleeping on a keyboard | Remedios44 | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Wikipedians_cat.jpg) | Released into the public domain by the author |
| Yawning cat | Scobull | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Yawning_cat.jpg) | Released into the public domain by the author |

The CanAI Community License does not replace the original terms of these photos.
