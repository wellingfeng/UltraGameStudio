# Claude Code workflows are useful. Premium quota runs out fast.

## Claude Code's new dynamic workflows are much quieter than MCP, Skills, or Hooks. This walkthrough calls them workflows.

For complex tasks, many people write a research HTML file, turn it into a technical-plan HTML file, and then hand it to AI for development. In practice, the result is often unstable. HTML is text for humans to read. It is not a script. Order consistency, parallelism, task boundaries, task splitting, and data exchange are all vague, so the model has to guess too much.

Workflows are scripts, so those structural choices can live in the process itself.

Workflows also support multi-angle exploration, adversarial validation, and plan voting. Let five agents run on the same problem, then have another agent merge the useful parts. The result is usually steadier, and the token bill grows fast.

Since this is so general, why should it be tied to one model or one CLI?

FreeUltraCode turns Claude Code-style workflows into a visual canvas, then lets the same workflow target Claude Code, Codex, Gemini, and more local or cloud runtimes.

This walkthrough uses a real change: make FreeUltraCode support multiple interface styles, use Pencil by default, and allow switching in Settings / Appearance.

Most of the work happens inside FreeUltraCode itself, so the tool gets tested while it is being built.

The walkthrough uses Codex as the default model.

### 0. Main interface

<p align="center">
  <img src="images/0-标题使用.png" alt="FreeUltraCode main interface" width="960">
</p>

The main FreeUltraCode interface has the workflows blueprint in the center, node properties on the right, and AI input and output at the bottom.

The main interface is roughly split into four parts: workflows history on the left, the visual canvas in the center, node properties and common prompts on the right, and AI input plus responses at the bottom.

### 1. Download FreeUltraCode

<p align="center">
  <img src="images/1-下载.png" alt="FreeUltraCode GitHub Releases" width="840">
</p>

Find the latest version from Releases on the right side of the GitHub project page.

### 2. Configure the large model first

By default, FreeUltraCode uses the CLI already configured on your system to start. You can use tools such as CC-Switch to configure it.

### 3. Create a new workflow, then enter the request

<p align="center">
  <img src="images/3-新建workflow.png" alt="Create a new workflow and enter the request" width="840">
</p>

After configuring the model, click "New workflows" on the left. The canvas will show a minimal structure: Start, one Agent, and End.

You do not need to manually animate or draw nodes. Use the AI input box in the lower-right corner. In this example, I entered:

```text
I want FreeUltraCode to support multiple interface styles,
use Pencil as the default design,
and allow switching in Settings / Appearance.
```

After writing it, press Ctrl+Enter or click the send button in the lower-right corner. FreeUltraCode turns this natural-language request into an editable workflows blueprint.

### 4-1. Generate the workflows blueprint

<p align="center">
  <img src="images/4-1生成workflow蓝图.png" alt="Generated workflows blueprint" width="960">
</p>

After sending the request, FreeUltraCode first reorganizes the current step into a complete workflow.

The blueprint in the screenshot is roughly:

```text
Start
  -> Explore appearance support in parallel
      -> Research existing appearance entry points
      -> Design the multi-style system
      -> Design the Pencil default style
  -> Summarize the implementation plan
  -> Implement multiple interface styles
  -> Connect Settings / Appearance switching
  -> Validate and run regression checks
  -> Record delivery results
  -> End
```

In the node properties panel on the right, you can continue editing the selected node's properties. Of course, more often you will use the input box at the bottom and let AI modify the blueprint nodes so the workflow can keep iterating.

### 4-2. View the generated script

<p align="center">
  <img src="images/4-2蓝图脚本.png" alt="Generated workflows script" width="960">
</p>

There is a "Script" entry in the top bar. Click it and you will see the script generated from the current blueprint.

In the screenshot, you can see structures such as parallel(...) and agent(...). Parallel nodes become concurrently executed branches, and regular nodes become individual agent calls.

This also shows that FreeUltraCode is not just drawing boxes. The canvas is backed by a unified workflows structure, which is why it can later connect to different runtimes.

### 5. Continue editing with common prompts on the right

<p align="center">
  <img src="images/5-使用常用提示词.png" alt="Use common prompts to continue editing workflows" width="960">
</p>

After the blueprint is generated, you do not have to run it immediately. The "Common Prompts" panel on the right is better for polishing the process, though you can also write prompts manually.

The prompts are grouped by scenario, such as interactive clarification, clarity, completeness, cost, structure, reliability, performance and parallelism, and verification and testing.

The screenshot uses "Clarify Requirements." It fills the AI input box with a prompt asking the AI to confirm key ambiguities interactively before modifying the blueprint.

This design is very useful. Many workflows fail not because the model cannot do the work, but because the goal, boundaries, failure paths, and cost strategy were not clear at the beginning.

There are also common prompts such as grill-me, complete boundary conditions, parallel optimization, and the single principle. You can add or modify prompts yourself.

### 6. Confirm boundaries through interactive choices

<p align="center">
  <img src="images/6-交互选择.png" alt="Interactive choices for confirming boundaries" width="640">
</p>

After clicking "Clarify Requirements," the AI does not change the graph directly. Instead, it first asks: "What scope should the interface-style switching feature land in?"

The screenshot offers two choices: only implement the Pencil default style and leave an extensible structure, or implement Pencil plus multiple switchable styles.

After you choose, the AI writes that decision back into the workflows blueprint and outputs the updated IRGraph. This step reduces the chance that the AI changes direction on its own.

### 7. Click Run

<p align="center">
  <img src="images/7-运行.png" alt="Run the workflows" width="960">
</p>

After the blueprint structure, model configuration, and key boundaries are confirmed, click "Run" in the top bar.

I recommend not running the blueprint immediately after generation. First check whether the parallel branches make sense, whether the summary node comes after the parallel branches, and whether validation covers the final result.

If a node only has an unclear responsibility, you can edit it in the node properties before running again.

### 8. Watch the running state

<p align="center">
  <img src="images/8-运行中.png" alt="Watch workflows running state" width="960">
</p>

After running, the top button changes to "Running... Stop." The AI input at the bottom is locked so the blueprint does not get changed during execution.

The canvas shows node status. In the screenshot, Start has completed, the following parallel node is running, and the top-right corner shows the run count. If something fails in the middle, you can continue from the previous task.

### 9. Switch interface style

<p align="center">
  <img src="images/9-切换风格.png" alt="Switch interface style" width="840">
</p>

After FreeUltraCode finishes development, restart the program and switch between different appearance styles in Settings / Appearance.

The screenshot shows style cards such as Pencil, Deep Night, Aurora, Daylight, and Ember. Selecting a style affects the global background, panels, borders, and run-state colors.

### What I think is truly useful

The most valuable part of FreeUltraCode is not wrapping a prompt in a UI.

It connects "request -> blueprint -> script -> run -> history review." You can first generate a process with natural language, inspect the structure on the canvas, use common prompts to fill in boundaries when needed, and only then run it.

The same workflows do not have to be naturally tied to one model. Simple nodes can use cheaper models, key nodes can use stronger models, and the execution target can continue expanding to Claude Code, Codex, Gemini, or other runtimes.

For complex AI coding tasks, this kind of decomposition is easier to maintain than one extremely long prompt. If one node fails, fix that node. If one branch is unnecessary, delete that branch. If you want reuse, continue editing from history.

### Still early, but the direction is worth watching

The whole concept of workflows is still early, and FreeUltraCode itself has only just started. Runtime adapters, node capabilities, and the script ecosystem will keep changing.

But the overall direction is clear: AI coding will not stay forever at "open a chat box, then manually push every step forward."

Complex tasks will eventually become workflows because they can be seen, edited, migrated, and reused.

### Bonus: don't want the UI? Two commands on the CLI are enough

Everything above is the GUI. But plenty of situations don't actually need a canvas — you might want to wire a workflow into CI, drop it into a shell script, or run it headless on a server. So FreeUltraCode also ships a command-line version, exposed through a skill called `/freeultracode`.

I deliberately kept it minimal: **from the user's side, there are only two commands**. On the CLI you don't need to think about blueprints, IRGraph, or compilation — **a workflow is just a `.js` script to you**, and everything else happens automatically.

```bash
fuc gen "build me a code-review workflow" -o review.js   # generate a workflow script from one sentence
fuc gen review.js "add a security-review node"           # modify an existing script with one sentence
fuc run review.js                                        # run the script
```

That's the whole surface area (really just two commands: `gen` and `run`).

**`fuc gen`** generates or modifies workflows from natural language. It's the same capability behind the AI input box at the bottom of the GUI: you describe what you want and it produces a script; you point at an existing script and describe a change, and it edits it for you.

One important detail: **it's zero-config — you don't have to plug in an API key**. It reuses the `claude` CLI that's already logged in on your machine (the same path the runtime uses), so as long as you have claude installed and authenticated, `fuc gen` just works. If it isn't installed, it'll nudge you to run `claude login` first.

**`fuc run`** executes a script, walking through it node by node and streaming progress to your terminal:

```text
[14:32:02] ▶ agent n_scan
[14:32:15] ✓ agent n_scan — 13.2s
[14:32:15] ▶ parallel n_review (3 branches)
[14:32:31] ✓ parallel n_review — 16.1s
done — 29.8s
```

Parallelism, pipelines, adversarial validation, automatic retries — all of that behaves exactly the same as hitting "Run" in the GUI, because **the CLI and the GUI share the same execution kernel**. One paints the result onto a canvas, the other prints it to a terminal.

A few flags you'll reach for: `--dry-run` does a preflight without spending tokens, `--resume` picks up from the last failed node, `--model` pins a specific model, and `--json` emits machine-readable output for pipelines.

The tradeoff in one line: **the GUI is for "seeing and editing," the CLI is for "running fast and plugging in," but both sit on top of the same workflow.**

QQ group: 149523963

Project:

https://github.com/wellingfeng/FreeUltraCode

Reference:

https://code.claude.com/docs/en/workflows
