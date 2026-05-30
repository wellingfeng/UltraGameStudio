This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OpenWorkflow is a visual editor for **Claude Code workflow scripts** — a blueprint-style canvas (think Unreal Engine node graphs) where AI agent workflows are authored visually and compiled to/from executable `agent()`/`parallel()`/`pipeline()` scripts. The entire application lives in `app/` (a single Vite + React 18 + TypeScript SPA). `docs/` holds the design doc and workflow-syntax reference (HTML); `pencil/` holds `.pen` design files.

## Commands

All commands run from the `app/` directory.

```bash
cd app
npm install        # first-time setup (run.bat does this automatically on Windows)
npm run dev        # Vite dev server at http://localhost:5173
npm run build      # tsc -b (project references) then vite build
npm run typecheck  # tsc --noEmit
npm run lint       # eslint . --ext ts,tsx
```

On Windows, `run.bat` (repo root) checks Node, installs deps if missing, starts the dev server, and opens the browser. There is **no test runner configured** — verify changes via `npm run typecheck` and the in-browser round-trip console (below).

### Round-trip verification (dev console)

In the browser dev console, `window.OpenWorkflow` exposes `roundtrip()`, `runRoundtripDemo()`, `emit(ir)`, `parse(src)`, and `sample`. Use `OpenWorkflow.roundtrip()` to confirm an IRGraph survives an emit→parse cycle (structural diffs are reported). This is the primary way to validate emitter/parser changes.

## Architecture

The system is built around one rule: **`IRGraph` is the single source of truth.** Everything else is a pure transform over it. Several modules document this as an explicit `CONTRACT:` in their header comment — treat those exported shapes as stable APIs and avoid changing them casually.

```
                    ┌──────────────────┐
   parseClaudeScript│                  │ emitClaudeScript
   (script → IR) ──►│     IRGraph      │──► (IR → Claude Code script)
                    │ (core/ir.ts)     │
                    └──────┬───────────┘
                           │ irToFlow (one-way projection)
                           ▼
                    React Flow canvas (BlueprintCanvas)
```

- **`core/ir.ts`** — the IR types (`IRGraph`, `IRNode`, `IREdge`, `IRPort`) plus the `EXEC`/`DATA` pin-kind constants. Two edge kinds matter throughout: **exec** (`▶` execution flow, the topological spine) and **data** (`●` data flow). Twelve `NodeType`s exist (`start`, `end`, `agent`, `parallel`, `pipeline`, `phase`, `branch`, `loop`, `workflow`, `log`, `variable`, `codeblock`).

- **`core/emitter.ts`** — `emitClaudeScript(ir)` compiles the IR into a Claude Code workflow script. It topologically orders nodes along the exec spine, assigns readable JS variable names, surfaces data edges as `from: [...]` options, and appends a `// @node <id>` annotation to every statement so the original node id can be recovered on parse.

- **`core/parser.ts`** — `parseClaudeScript(src)` is the inverse. It uses `@babel/parser` to walk top-level statements, maps known calls (`phase`/`agent`/`parallel`/`pipeline`/`workflow`/`log`) to nodes, wires the exec spine sequentially (with synthetic `start`/`end` sentinels), and reconstructs data edges from `from:` options or identifier references to earlier bindings. The `// @node` annotations make emit→parse **lossless**. Unknown statements become `codeblock` nodes (verbatim source); a fatal parse error wraps the whole script in one codeblock so the canvas never breaks.

- **`core/roundtrip.ts`** — the verification harness and `window.OpenWorkflow` console install (`installRoundtripConsole`).

- **`canvas/irToFlow.ts`** — pure, one-way projection of `IRGraph` → React Flow `{nodes, edges}`. Maps IR node types to registered custom components (`agent`, `parallel`, `control`); unknown types fall back to the agent card so rendering never throws. Exec edges are animated solid lines; data edges are dashed.

- **`canvas/BlueprintCanvas.tsx`** — re-projects `store.workflow` onto the canvas via `irToFlow` whenever it changes, mirrors store selection onto React Flow `selected` flags, and routes node clicks back to `store.selectNode`.

- **`store/useStore.ts`** — the single Zustand store (also a documented `CONTRACT`). Holds `workflow` (the IRGraph) + selection, plus session/message/prompt UI state seeded from `store/sampleSessions.ts`. AI-driven graph editing is currently a stub (`sendPrompt` appends a placeholder assistant message).

### Layout & conventions

- `App.tsx` is the three-zone layout (Sidebar | Canvas+AIDock | PromptPanel) and the consumer of every import contract.
- Path alias `@/` → `app/src/` (configured in both `vite.config.ts` and `tsconfig.json`).
- Styling is Tailwind (`tailwind.config.ts`) with CSS variables (`var(--accent)`, `var(--bg)`, etc.) defined in `styles/global.css`; components reference theme tokens, not raw colors.
- TypeScript uses project references (`tsc -b`); `build` typechecks before bundling.

### Where to make changes

- Adding/altering a workflow primitive (node type) touches: `core/ir.ts` (the `NodeType` union), `core/emitter.ts` (emit case), `core/parser.ts` (parse case), and `canvas/irToFlow.ts` + a `canvas/nodes/*` component (rendering). Keep emitter and parser in sync, then confirm with `OpenWorkflow.roundtrip()`.
- The IR shape, the store surface, and the emitter/parser output format are inter-dependent contracts. When changing one, update the others and re-run the round-trip check.
