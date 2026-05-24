# lance
AI chat toolkit — export, Obsidian sync, Enter-as-newline, settings dashboard.

Supports: ChatGPT, Claude, Gemini, Grok, DeepSeek, Yuanbao

## Files
- `lance.user.js` — Tampermonkey userscript (install via tampermonkey.net)
- `lance-relay.js` — Node.js localhost relay for silent Obsidian export (port 27184)
- `autostart/lance-relay.plist` — macOS LaunchAgent
- `autostart/lance-relay.service` — Linux systemd user service

## Relay setup (macOS)
```bash
mkdir -p ~/.local/scripts
cp lance-relay.js ~/.local/scripts/
sed -i '' "s/YOURUSERNAME/$USER/g" autostart/lance-relay.plist
cp autostart/lance-relay.plist ~/Library/LaunchAgents/user.lance.relay.plist
launchctl load ~/Library/LaunchAgents/user.lance.relay.plist
curl -s http://127.0.0.1:27184/ping | cat
```

## Relay setup (Linux)
```bash
mkdir -p ~/.local/scripts ~/.config/systemd/user
cp lance-relay.js ~/.local/scripts/
sed -i "s/YOUR_USERNAME/$USER/g" autostart/lance-relay.service
cp autostart/lance-relay.service ~/.config/systemd/user/
systemctl --user enable --now lance-relay
```
