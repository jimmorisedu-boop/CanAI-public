# CanAI user guide

CanAI runs locally from one folder. The local backend is part of the app and stores your boards on this computer. Your personal boards, media, settings, jobs, and logs remain under `server/data/` in this folder.

[Visual Getting Started](docs/GETTING-STARTED.md) · [Visual Help index](docs/help/README.md)

## Start and stop

On Windows, double-click **Start CanAI.bat**. On macOS Apple Silicon, double-click **Start CanAI.command**. The first run may download Node.js and install server dependencies, then opens the app in your browser. The default URL is `http://127.0.0.1:8787`; when that port is busy, the launcher selects a free pair and prints the actual address.

Stop with **Stop CanAI.bat** or **Stop CanAI.command**. Keep the launcher window open while CanAI is running.

Open **Help** from the `?` control for the full offline guide. Search by task,
open a category, and follow the illustrated steps; **Show first steps again**
replays the short introduction when you need it.

To update a release installation, extract the new release ZIP into a new folder and migrate your data as described below. Use **Migrate data.bat** or **Migrate data.command** in the new folder, choose the old folder, and check the boards before removing the old copy. The migration copies `server/data/` and `server/.env`, leaves the old folder intact, and sets aside data already present in the new folder.

If **Recovered data needs review** appears, CanAI has restored a validated backup of its board index or task store. Stop the app and keep a copy of the whole folder before repairing missing work. Damaged originals remain beside the recovered files as `.corrupt-…` copies. Tasks with a saved provider request continue using that request; uncertain unfinished tasks stay on hold so recovery cannot silently charge you again. Automatic media cleanup stays paused across restarts.

Review and repair the recovered boards and Tasks before clearing this protection. With CanAI stopped, remove only the relevant `server/data/projects.json.recovery-pending` or `server/data/jobs.json.recovery-pending` marker after that review; keep the backups and damaged originals. Restart CanAI to resume normal cleanup. If you cannot verify the recovered state, leave the markers in place and save a problem report for support.

## Canvas and generation

Enter a Prompt in the bottom bar, choose **Image**, **Video**, or **Audio**, review the selected model and quote, then press **Generate**. Results are placed near their references. Click a canvas object to use it as a reference; drag an object into Assistant to attach it to one chat message.

Tasks lets you cancel or retry work. Generation continues after closing a panel or restarting the app. A request already submitted to fal.ai is resumed by its request ID rather than submitted twice.

## Assistant

Open **Assistant** in the canvas. Ask for an explanation or for ready-to-run prompts. **Send** shows the estimated cost; required confirmations follow your settings. An explicit request to create or edit media can start generation on the canvas. Requests only for prompts do not start generation. A prompt card offers **Generate**, **Use prompt**, **Copy**, and **Add to canvas**. **Use prompt** fills the Prompt field; **Add to canvas** creates a text card and does not generate media. Suggested prompts can also be run with **Generate**.

The Assistant responds in the language you request. It can use only the files and references attached to the current message; it does not automatically see every object on the board.

## fal.ai key and models

Real generation requires a fal.ai key. Add it in **Settings → fal.ai and models**; a restart is not required. The key is stored in `server/.env` and is sent only to fal.ai. Mock mode (`CANAI_MOCK=1`) is for developer checks and is never enabled automatically.

## Where data lives

| Data | Location |
| --- | --- |
| Boards and versions | `server/data/projects/` |
| Trash | `server/data/trash/` |
| Prompt chat history | `server/data/prompt-chats/` |
| Images, video, and other media | `server/data/media/` |
| Active and recent jobs | `server/data/jobs.json` |
| Settings | `server/data/settings.json` |
| fal.ai key | `server/.env` |
| Server log | `server/data/logs/server.log` |

Copy the entire CanAI folder for a portable backup. For a shared copy, remove `server/.env` and personal `server/data/` first.

## Troubleshooting

- A failed generation appears as an error card. Open Tasks to retry it.
- A deleted board can be restored from Trash.
- If import is stuck, cancel and retry from the import panel.
- If another tab changed the same board, choose the server version or save your local copy.
- If CanAI closed during generation, start it again; queued work is recovered.
- If an external editor does not open, set and test its path in Settings.
- For a detailed failure, send the latest lines from `server/data/logs/server.log` to the person supporting your installation.
