# Pi Config Cleanup Analysis

**Generated:** 2025-08-20
**Config:** `/Users/cesc/src/config.pi`

---

## 🗑️ Dead / Unused (Remove Immediately)

- [ ] `agent/skills/zellij/` — You don't use zellij
- [ ] `agent/settings-unix.json:17` — Remove `"-skills/zellij/SKILL.md"` from skills array
- [ ] `agent/extensions/azure-devops-mcp/` — Empty `node_modules/`, no `package.json`, no `index.ts`; disabled in `mcp.json`
- [ ] `web-search.json` (root) — Duplicate of `agent/web-search.json` (identical content)
- [ ] `free.log` (742K) — Runtime log, already in `.gitignore`
- [ ] `free-telemetry.json` (94K) — Telemetry cache, already in `.gitignore`
- [ ] `opencode-catalog-cache.json` (115K) — Cache, already in `.gitignore`
- [ ] `provider-cache.json` (540K) — Cache, already in `.gitignore`

---

## 🔄 Duplicated / Overlapping

- [ ] **WezTerm**: `agent/extensions/wezterm.ts` (extension) + `agent/skills/wezterm/SKILL.md` (skill) — Same purpose, different interfaces. **Pick one.**
- [ ] **Answer vs ask-user-question**: `answer.ts` (`/answer` command + `ctrl+.` shortcut) extracts Qs from last assistant msg. `ask-user-question.ts` registers `ask_user_question` tool for agent to call. Different UX but overlapping intent.
- [ ] **Git tool**: `git-tool.ts` registers a `git` tool. Check if pi now has a built-in git tool (likely).
- [ ] **Goal extension**: `goal.ts` registers `get_goal`/`create_goal`/`update_goal` tools — These match built-in tools in the tool namespace. Likely redundant.
- [ ] **web-search.json**: Two identical files (root + agent/).

---

## 🧹 Unnecessary / Low Value (Audit & Prune)

- [ ] `agent/skills/ghidra/` — 276-line skill + 6 Java scripts. Keep only if reverse-engineering binaries regularly.
- [ ] `agent/skills/graphify/` — Heavy skill (39K SKILL.md). Only useful if you have `graphify-out/` locally.
- [ ] `agent/skills/karpathy-llm-wiki/` — 39K SKILL.md + templates/scripts. Keep only if actively building a personal wiki.
- [ ] `agent/skills/web-browser/` — 13 JS scripts + CDP automation. Heavy. Keep only if you need browser automation beyond search.
- [ ] `agent/skills/librarian/` — `checkout.py` for caching repos. Useful but can be a one-liner `git clone --filter=blob:none`.
- [ ] `durable/` — `reviewer.ts` demo script + `package.json`. Not an extension/skill — just a test file.
- [ ] `agents/semble-search.md` — Single markdown file — not a skill/agent. Move to docs or delete.
- [ ] `context-mode/`, `agents/`, `durable/` — Empty-ish dirs tracked in git. Clean up.
- [ ] `agent/npm/` — Only `package-lock.json` + `package.json` for 6 deps. Could be root-level or removed if deps are in extensions.

---

## ⚙️ Settings Cleanup

### `agent/settings-unix.json`
- [ ] Remove `"-skills/zellij/SKILL.md"` from skills array
- [ ] Review package sources — some may be unused:
  - `git:github.com/DietrichGebert/ponytail`
  - `git:github.com/chandra447/pi-hermes-memory`
  - `npm:@ff-labs/pi-fff`
  - `npm:pi-web-access`
  - `npm:pi-autoresearch`
  - `npm:pi-free`

### `agent/mcp.json`
- [ ] `ado` server disabled — remove if not used

---

## ✅ Recommended Execution Order

### Phase 1: Safe Deletes (No Risk)
- [ ] Delete `agent/skills/zellij/`
- [ ] Remove from `settings-unix.json` skills array
- [ ] Delete `agent/extensions/azure-devops-mcp/`
- [ ] Delete root `web-search.json` (keep `agent/web-search.json`)
- [ ] `git rm -r --cached agents context-mode durable`
- [ ] Add `agents/`, `context-mode/`, `durable/` to `.gitignore`
- [ ] `git rm --cached free.log free-telemetry.json opencode-catalog-cache.json provider-cache.json`

### Phase 2: Choose WezTerm Integration
- [ ] **Decision**: Keep extension (`wezterm.ts`) OR skill (`skills/wezterm/`), not both
- [ ] Recommendation: Keep extension (`wezterm.ts`) — integrated with pi events

### Phase 3: Audit Potential Duplicates with Built-ins
- [ ] Test if `goal.ts` tools shadow built-ins → delete if redundant
- [ ] Test if `git-tool.ts` shadows built-in git tool → delete if redundant
- [ ] Review `answer.ts` vs `ask-user-question.ts` — decide if both needed

### Phase 4: Prune Unused Skills (Optional)
- [ ] `ghidra` — delete if not reverse-engineering
- [ ] `graphify` — delete if no local `graphify-out/`
- [ ] `karpathy-llm-wiki` — delete if not building wiki
- [ ] `web-browser` — delete if only need search (not automation)
- [ ] `librarian` — keep or replace with simple git clone

### Phase 5: Clean Up `agent/npm/`
- [ ] Move deps to root or remove if extensions self-contained
- [ ] Delete `agent/npm/` dir

---

## ⚠️ Risk Notes

- **`goal.ts` and `git-tool.ts`** may shadow built-in tools. Test after removal.
- **`ponytail` and `pi-hermes-memory`** are git deps — verify they're actually used before removing from packages.
- **WezTerm extension** (`wezterm.ts`) hooks into pi events (`session_start`, `agent_start`, etc.) — the skill is passive documentation. Extension is more powerful.

---

## 📋 Commands to Execute (Phase 1)

```bash
cd /Users/cesc/src/config.pi

# 1. Remove zellij skill
rm -rf agent/skills/zellij

# 2. Remove dead azure-devops-mcp
rm -rf agent/extensions/azure-devops-mcp

# 3. Remove duplicate web-search.json (root)
rm web-search.json

# 4. Untrack runtime dirs
git rm -r --cached agents context-mode durable

# 5. Add to .gitignore
echo "agents/" >> .gitignore
echo "context-mode/" >> .gitignore
echo "durable/" >> .gitignore

# 6. Untrack large cache files (if tracked)
git rm --cached free.log free-telemetry.json opencode-catalog-cache.json provider-cache.json 2>/dev/null

# 7. Edit settings-unix.json: remove "-skills/zellij/SKILL.md" from skills array
# (manual edit or use jq)
```

---

## ✅ Progress Tracker

| Phase | Task | Status | Notes |
|-------|------|--------|-------|
| 1 | Delete `agent/skills/zellij/` | ☐ | |
| 1 | Remove zellij from `settings-unix.json` | ☐ | |
| 1 | Delete `agent/extensions/azure-devops-mcp/` | ☐ | |
| 1 | Delete root `web-search.json` | ☐ | |
| 1 | `git rm -r --cached agents context-mode durable` | ☐ | |
| 1 | Add dirs to `.gitignore` | ☐ | |
| 1 | `git rm --cached` cache files | ☐ | |
| 2 | Choose WezTerm: extension vs skill | ☐ | |
| 2 | Remove unused WezTerm integration | ☐ | |
| 3 | Test `goal.ts` vs built-ins | ☐ | |
| 3 | Test `git-tool.ts` vs built-in | ☐ | |
| 3 | Review `answer.ts` vs `ask-user-question.ts` | ☐ | |
| 4 | Prune `ghidra` skill | ☐ | |
| 4 | Prune `graphify` skill | ☐ | |
| 4 | Prune `karpathy-llm-wiki` skill | ☐ | |
| 4 | Prune `web-browser` skill | ☐ | |
| 4 | Prune/keep `librarian` skill | ☐ | |
| 5 | Clean up `agent/npm/` | ☐ | |

---

**Legend:** ☐ = Not started | ☑ = Done | ⏭ = Skipped

Update the table above as you complete each task.