# Claude Code Has Dynamic Workflows. What About Other Models? An Open-Source Alternative: OpenWorkflows

## I have been looking at Claude Code's new dynamic workflows. Compared with MCP, Skill, and Hooks, very few people are talking about this new feature. I will call them workflows below.

For complex tasks, many people used to first write a research HTML file, then turn it into a technical-plan HTML file, and finally hand it to AI for development. In practice, the result is often not good. The main reason is that HTML is text for humans to read. It is not a script, and it lacks structured information. Order consistency, how much work can run in parallel, whether boundaries are clear, how tasks are divided, and how tasks exchange information are all unclear, so the AI has to guess too much.

Workflows themselves are scripts, so they can solve this problem directly.

Workflows also support multi-angle exploration, adversarial validation, and plan voting. That is why they can be more accurate. They win by scale: let five agents run on the same problem at the same time, then have another agent summarize the results. It is indeed more accurate, and it burns tokens fast.

Since this is so general, why should it be tied to one model or one CLI?

Following that idea, I built OpenWorkflows, or more precisely, AI built it. It turns Claude Code-style workflows into a visual canvas, and tries to make the same workflow target Claude Code, Codex, Gemini, and more local or cloud runtimes.

This time I will not talk about abstract concepts. I will walk through the screenshots directly. The example is concrete: make OpenWorkflows support multiple interface styles, use Pencil by default, and allow switching in Settings / Appearance.

During development, I tried to do as much as possible inside OpenWorkflows so it could bootstrap itself.

The following process uses CodeX as the default large model for development.

### 0. Start with the final interface

<p align="center">
  <img src="images/0-标题使用.png" alt="OpenWorkflows main interface" width="960">
</p>

The main OpenWorkflows interface has the workflows blueprint in the center, node properties on the right, and AI input and output at the bottom.

The main interface is roughly split into four parts: workflows history on the left, the visual canvas in the center, node properties and common prompts on the right, and AI input plus responses at the bottom.

### 1. Download OpenWorkflows

<p align="center">
  <img src="images/1-下载.png" alt="OpenWorkflows GitHub Releases" width="840">
</p>

Find the latest version from Releases on the right side of the GitHub project page.

### 2. Configure the large model first

By default, OpenWorkflows uses the CLI already configured on your system to start. You can use tools such as CC-Switch to configure it.

### 3. Create a new workflow, then enter the request

<p align="center">
  <img src="images/3-新建workflow.png" alt="Create a new workflow and enter the request" width="840">
</p>

After configuring the model, click "New workflows" on the left. The canvas will show a minimal structure: Start, one Agent, and End.

You do not need to manually animate or draw nodes. Use the AI input box in the lower-right corner. In this example, I entered:

```text
I want OpenWorkflows to support multiple interface styles,
use Pencil as the default design,
and allow switching in Settings / Appearance.
```

After writing it, press Ctrl+Enter or click the send button in the lower-right corner. OpenWorkflows turns this natural-language request into an editable workflows blueprint.

### 4-1. Generate the workflows blueprint

<p align="center">
  <img src="images/4-1生成workflow蓝图.png" alt="Generated workflows blueprint" width="960">
</p>

After sending the request, OpenWorkflows first reorganizes the current step into a complete workflow.

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

This also shows that OpenWorkflows is not just drawing boxes. The canvas is backed by a unified workflows structure, which is why it can later connect to different runtimes.

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

After OpenWorkflows finishes development, restart the program and switch between different appearance styles in Settings / Appearance.

The screenshot shows style cards such as Pencil, Deep Night, Aurora, Daylight, and Ember. Selecting a style affects the global background, panels, borders, and run-state colors.

### What I think is truly useful

The most valuable part of OpenWorkflows is not wrapping a prompt in a UI.

It connects "request -> blueprint -> script -> run -> history review." You can first generate a process with natural language, inspect the structure on the canvas, use common prompts to fill in boundaries when needed, and only then run it.

The same workflows do not have to be naturally tied to one model. Simple nodes can use cheaper models, key nodes can use stronger models, and the execution target can continue expanding to Claude Code, Codex, Gemini, or other runtimes.

For complex AI coding tasks, this kind of decomposition is easier to maintain than one extremely long prompt. If one node fails, fix that node. If one branch is unnecessary, delete that branch. If you want reuse, continue editing from history.

### Still early, but the direction is worth watching

The whole concept of workflows is still early, and OpenWorkflows itself has only just started. Runtime adapters, node capabilities, and the script ecosystem will keep changing.

But the overall direction is clear: AI coding will not stay forever at "open a chat box, then manually push every step forward."

Complex tasks will eventually become workflows because they can be seen, edited, migrated, and reused.

QQ group: 149523963

Project:

https://github.com/wellingfeng/OpenWorkflows

Reference:

https://code.claude.com/docs/en/workflows
