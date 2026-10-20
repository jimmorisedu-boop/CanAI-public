# Help maintenance

CanAI Help is an offline, user-facing guide. The source of truth is
`client/src/help/content/guide.json`; `client/src/help/content/index.ts` exposes
the typed categories and topics to the Help panel. Every step has a local SVG
under `client/public/help/`. Keep the wording short enough to scan beside the
Canvas and describe the current local app, not Cloud-only administration.

Run the deterministic check after editing content, images, or a user-facing
workflow:

```sh
npm run check:help
```

The same canonical guide is published as readable, offline GitHub Markdown in
`docs/help/`. Regenerate the index and one page per topic after changing the
guide or its step illustrations, then run the freshness check:

```sh
npm run docs:help
npm run check:help
```

`docs/help/README.md` and the topic pages are generated files. Do not edit them
by hand; the JSON guide and local SVGs remain the source of truth. Each page
links back to the index, the repository README, and `docs/GETTING-STARTED.md`.

For a change prepared on top of a branch, also check drift coverage:

```sh
node scripts/check-help.mjs --base <git-ref>
```

The base check compares changed user-facing source paths with the map below.
It requires a guide or Help image update for each mapped change and reports a
new source path that has no map entry. This is a coverage check, not an
absolute semantic guarantee; a human still reviews the topic, screenshot
labels, and workflow accuracy.

<!-- HELP_COVERAGE_START
[
  {"prefix":"client/src/App.tsx","topics":["quick-start","settings-provider","navigation-shortcuts"]},
  {"prefix":"client/src/main.tsx","topics":["quick-start","navigation-shortcuts"]},
  {"prefix":"client/src/types.ts","topics":["recovery","pending-jobs"]},
  {"prefix":"client/src/api.ts","topics":["tasks-retry","recovery"]},
  {"prefix":"client/src/ui/systemMessage.ts","topics":["tasks-retry"]},
  {"prefix":"client/src/ui/LocalRecoveryNotice.tsx","topics":["recovery"]},
  {"prefix":"client/src/projects/ProjectsScreen.tsx","topics":["library","archive-trash","versions","project-files","recovery"]},
  {"prefix":"client/src/styles/gallery.css","topics":["quick-start","library","archive-trash"]},
  {"prefix":"client/src/settings/FalModelWizard.tsx","topics":["custom-model","settings-provider","models","variants-cost"]},
  {"prefix":"client/src/settings/","topics":["settings-provider","settings-local","tablet-lan","cloud-boundary","external-editor"]},
  {"prefix":"client/src/projects/CreateBoardDialog.tsx","topics":["quick-start","library"]},
  {"prefix":"client/src/projects/canaiImport.ts","topics":["project-files"]},
  {"prefix":"client/src/projects/","topics":["library","archive-trash","versions","export"]},
  {"prefix":"client/src/tablet/TabletClip","topics":["timeline","tablet-gestures"]},
  {"prefix":"client/src/tablet/ClipTrack.tsx","topics":["timeline","tablet-gestures"]},
  {"prefix":"client/src/ui/MediaPlaybackControls.tsx","topics":["references","timeline"]},
  {"prefix":"client/src/tablet/","topics":["tablet-lan","tablet-gestures","references","import","export","recovery"]},
  {"prefix":"client/src/spaces/nodes/PromptMacros.tsx","topics":["macros"]},
  {"prefix":"client/src/spaces/nodes/","topics":["workflow-editor","macros","macro-library","models"]},
  {"prefix":"client/src/spaces/canvas/AssetBar.tsx","topics":["assets"]},
  {"prefix":"client/src/spaces/canvas/AssistantShelf.tsx","topics":["assistant-basics","assistant-chats","assistant-refs","assistant-run"]},
  {"prefix":"client/src/spaces/canvas/AssistantPresetEditor.tsx","topics":["assistant-profiles"]},
  {"prefix":"client/src/spaces/canvas/AssistantLibrary.tsx","topics":["assistant-profiles"]},
  {"prefix":"client/src/spaces/canvas/AssistantPresets.tsx","topics":["assistant-profiles","assistant-chats","assistant-run","macro-library"]},
  {"prefix":"client/src/spaces/canvas/PromptBar.tsx","topics":["references","generation-modes","models","variants-cost","assistant-memory"]},
  {"prefix":"client/src/spaces/canvas/CompareViewer.tsx","topics":["compare"]},
  {"prefix":"client/src/spaces/canvas/timeline/","topics":["timeline"]},
  {"prefix":"client/src/spaces/canvas/konva/crop","topics":["crop-sketch"]},
  {"prefix":"client/src/spaces/canvas/konva/sketch","topics":["sketch"]},
  {"prefix":"client/src/spaces/canvas/archive/","topics":["library","archive-trash","export"]},
  {"prefix":"client/src/spaces/canvas/konva/zipExport.ts","topics":["export"]},
  {"prefix":"client/src/spaces/canvas/konva/","topics":["import","references","reference-kinds","assistant-photos","assets","restore-generation","pending-jobs","tasks-retry","navigation-shortcuts"]},
  {"prefix":"client/src/spaces/canvas/","topics":["import","references","reference-kinds","assistant-photos","assets","generation-modes","models","variants-cost","restore-generation","pending-jobs","tasks-retry","crop-sketch","sketch","external-editor","compare","timeline","export","navigation-shortcuts"]},
  {"prefix":"client/src/ShortcutsModal.tsx","topics":["quick-start","recovery","navigation-shortcuts"]},
  {"prefix":"client/src/ui/","topics":["quick-start","references","assets","generation-modes","models","pending-jobs","navigation-shortcuts"]},
  {"prefix":"client/src/styles/board-participants.css","topics":["navigation-shortcuts","tablet-gestures"]},
  {"prefix":"server/src/remoteApp.ts","topics":["tablet-lan","tablet-gestures"]},
  {"prefix":"server/src/remoteAccess.ts","topics":["tablet-lan"]},
  {"prefix":"server/src/durableJsonRecovery.ts","topics":["recovery"]},
  {"prefix":"server/src/jobs.ts","topics":["recovery","pending-jobs"]},
  {"prefix":"server/src/projects.ts","topics":["recovery","versions"]},
  {"prefix":"server/src/gc.ts","topics":["recovery"]},
  {"prefix":"server/src/tabletHelpAssets.ts","topics":["tablet-lan","tablet-gestures"]},
  {"prefix":"server/src/catalog.ts","topics":["models","custom-model","variants-cost"]},
  {"prefix":"server/src/falModelSetup.ts","topics":["custom-model","settings-provider","variants-cost"]},
  {"prefix":"server/src/discoverFalModel.ts","topics":["custom-model","models"]},
  {"prefix":"server/src/generation","topics":["generation-modes","pending-jobs","tasks-retry","restore-generation","recovery"]},
  {"prefix":"server/src/promptChat","topics":["assistant-basics","assistant-chats","assistant-refs","assistant-run","assistant-memory","assistant-photos"]},
  {"prefix":"server/src/refs.ts","topics":["references","reference-kinds","assistant-memory","assistant-photos"]},
  {"prefix":"server/src/mediaImport","topics":["import","assets","tasks-retry"]},
  {"prefix":"server/src/exportNumbers.ts","topics":["export"]},
  {"prefix":"server/src/cloudExports.ts","topics":["export","cloud-boundary"]}
]
HELP_COVERAGE_END -->

## Pull request checklist

- [ ] I ran `npm run check:help` and, when the change has a relevant base, `node scripts/check-help.mjs --base <git-ref>`.
- [ ] I regenerated `docs/help/` with `npm run docs:help` when Help content or illustrations changed.
- [ ] The changed user-facing workflow has a matching topic, notes, shortcuts,
      and local SVG labels where those details changed.
- [ ] Every step still has a distinct, readable `/help/*.svg` image with no
      external URL, font, script, or embedded data.
- [ ] The topic names the real control (`Generate`, `Send`, `Use prompt`,
      `Add to canvas`, `Workflow`, `Macro`, and `Assets`) and does not promise
      Cloud-only operations.
- [ ] I checked paid-call, provider-key, local privacy, and recovery wording
      against the current code and kept confirmation behavior explicit.
- [ ] I performed a manual review of the Help panel at its smallest supported
      size and checked the first-generation intro flow.

When adding a feature, update the relevant Help topic in the same change. If
the feature changes first-run behavior, update the intro target and its five
short screens as well. Keep IDs stable so saved Help links and related topics
continue to resolve.
