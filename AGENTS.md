# Repository Guidelines

## Project Structure & Module Organization
OpenWorkflow is a Tauri desktop app. The React 18 + Vite + TypeScript SPA lives in `app/src/`. Core workflow logic is in `app/src/core/` (`ir.ts`, parser, emitter, round-trip checks), React Flow canvas code is in `app/src/canvas/`, UI panels are in `app/src/panels/`, shared components are in `app/src/components/`, and Zustand state is in `app/src/store/`. Native Tauri/Rust code and configuration live in `app/src-tauri/`. Reference docs are in `docs/`, and Pencil design files are in `pencil/`. Treat `app/node_modules/`, `app/dist/`, and `app/src-tauri/target/` as generated outputs.

## Build, Test, and Development Commands
Run app commands from `app/`:

```bash
npm install        # install frontend and Tauri CLI dependencies
npm run dev        # start Vite at http://localhost:5173
npm run build      # run tsc -b, then create the Vite build
npm run typecheck  # TypeScript check without emitting files
npm run lint       # ESLint for .ts and .tsx files
npm run desktop    # run Tauri in development mode
npm run package    # build the production Tauri app
```

From the repository root, `run.bat` rebuilds when sources change and launches the Windows executable; `build.bat` packages the Windows installer.

## Coding Style & Naming Conventions
Use strict TypeScript and the `@/` path alias for imports from `app/src/`. Follow the existing two-space indentation, single-quoted strings, and semicolons. Name React components in `PascalCase.tsx`, hooks as `useSomething.ts`, and shared types in `types.ts` or the owning module. Prefer Tailwind classes and CSS variables from `app/src/styles/global.css` over raw colors.

## Testing Guidelines
No dedicated test runner is configured. Validate changes with `npm run typecheck` and `npm run lint`. For parser, emitter, or IR changes, also run the app and use the browser console helpers exposed on `window.OpenWorkflow`, especially `OpenWorkflow.roundtrip()`, to verify emit-parse stability.

## Commit & Pull Request Guidelines
This checkout has no local Git history available, so use concise imperative commit subjects such as `Add roundtrip fixture` or `Fix canvas selection state`. Pull requests should describe the behavior change, list verification commands, link related issues, and include screenshots or short recordings for UI changes.

## Architecture Notes
`IRGraph` is the single source of truth. Changes to workflow primitives usually require coordinated updates in `core/ir.ts`, `core/emitter.ts`, `core/parser.ts`, `canvas/irToFlow.ts`, and the relevant node component. Keep parser and emitter behavior synchronized.
