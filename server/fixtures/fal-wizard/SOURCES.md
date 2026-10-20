# Тестовые файлы мастера fal.ai

Файлы получены 14 октября 2026 из открытых примеров MDN. Лицензия CC0 1.0 Universal сохранена в LICENSE.txt.

- flower.mp4: https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4
- sample.mp3: https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3
- flower.jpg и flower-end.jpg: кадры этого flower.mp4 на 0,5 и 3 секунде, ширина 640 px; извлечены локальным ffmpeg. Они не созданы генеративной моделью.
- Лицензия источника: https://github.com/mdn/interactive-examples/blob/main/LICENSE

SHA-256 всех медиа закреплён в server/src/falModelTestSamples.ts. При подготовке теста нужные файлы копируются в portable media и передаются модели только после отдельного подтверждения теста. Подготовка не использует файлы настоящих досок и не вызывает платную генерацию. Интернет для повторного получения этих примеров не требуется.
