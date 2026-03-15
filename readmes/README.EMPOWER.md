# RedAmon Agent Empowerment: Advanced Reasoning & Multi-Agent Techniques

> A comprehensive exploration of techniques to evolve the RedAmon agent from a single ReAct loop into a deeply-reasoning, multi-agent system with strategic planning capabilities.

---

## Table of Contents

1. [Current Architecture Analysis](#1-current-architecture-analysis)
2. [Tier 1: Immediate Wins (Low Complexity, High Impact)](#2-tier-1-immediate-wins)
   - 2.1 [Think Node / Inner Monologue](#21-think-node--inner-monologue)
   - 2.2 [Chain-of-Verification (CoVe)](#22-chain-of-verification-cove)
   - 2.3 [Tool-Use Planning](#23-tool-use-planning)
   - 2.4 [System 1 / System 2 Thinking](#24-system-1--system-2-thinking)
   - 2.5 [Self-Consistency Voting](#25-self-consistency-voting)
3. [Tier 2: High-Value Investments (Medium Complexity)](#3-tier-2-high-value-investments)
   - 3.1 [Hierarchical Planning (Plan-and-Act)](#31-hierarchical-planning-plan-and-act)
   - 3.2 [Reflexion (Learning from Failures)](#32-reflexion-learning-from-failures)
   - 3.3 [Dynamic Prompt Assembly (Context Engineering)](#33-dynamic-prompt-assembly-context-engineering)
   - 3.4 [Critic / Verifier Agents](#34-critic--verifier-agents)
   - 3.5 [Meta-Cognition / Metacognitive Monitoring](#35-meta-cognition--metacognitive-monitoring)
   - 3.6 [Experience Replay / Episodic Memory](#36-experience-replay--episodic-memory)
   - 3.7 [RAG-Enhanced Reasoning](#37-rag-enhanced-reasoning)
   - 3.8 [Parallel Agent Architectures](#38-parallel-agent-architectures)
4. [Tier 3: Strategic Investments (High Complexity, High Impact)](#4-tier-3-strategic-investments)
   - 4.1 [Tree-of-Thought (ToT)](#41-tree-of-thought-tot)
   - 4.2 [Graph-of-Thought (GoT)](#42-graph-of-thought-got)
   - 4.3 [Monte Carlo Tree Search (MCTS)](#43-monte-carlo-tree-search-mcts)
   - 4.4 [Test-Time Compute (TTC)](#44-test-time-compute-ttc)
   - 4.5 [World Models / Mental Simulation](#45-world-models--mental-simulation)
5. [Tier 4: Advanced Multi-Agent Patterns](#5-tier-4-advanced-multi-agent-patterns)
   - 5.1 [Multi-Agent Debate](#51-multi-agent-debate)
   - 5.2 [Mixture of Agents (MoA)](#52-mixture-of-agents-moa)
   - 5.3 [Agent Swarms](#53-agent-swarms)
   - 5.4 [Cognitive Architectures (ACT-R / SOAR)](#54-cognitive-architectures)
6. [Supplementary Techniques](#6-supplementary-techniques)
   - 6.1 [Chain-of-Abstraction](#61-chain-of-abstraction)
   - 6.2 [Skeleton-of-Thought](#62-skeleton-of-thought)
   - 6.3 [Progressive Deepening](#63-progressive-deepening)
   - 6.4 [Speculative Execution](#64-speculative-execution)
   - 6.5 [Reward Modeling / Self-Reward](#65-reward-modeling--self-reward)
   - 6.6 [Constitutional AI / Self-Critique](#66-constitutional-ai--self-critique)
   - 6.7 [Tool-Augmented Reasoning](#67-tool-augmented-reasoning)
   - 6.8 [Beam Search Decoding for Reasoning](#68-beam-search-decoding-for-reasoning)
7. [Implementation Roadmap](#7-implementation-roadmap)
8. [Summary Matrix](#8-summary-matrix)
9. [References](#9-references)

---

## 1. Current Architecture Analysis

### What We Have Today

RedAmon's agent is a **LangGraph-based ReAct loop** (`agentic/orchestrator.py`) with this graph:

```
START → initialize → think → [route] → END
                       ↓         ↓
              execute_tool    execute_plan (parallel wave)
                       ↓         ↓
                   think ←───────┘
                       ↓
                await_approval / await_question (pause)
```

**Nodes:** `initialize`, `think`, `execute_tool`, `execute_plan`, `await_approval`, `process_approval`, `await_question`, `process_answer`, `generate_response`

**State:** `AgentState` TypedDict (`agentic/state.py:324-389`) tracking messages, iteration count, phase, execution trace, todo list, objectives, target info, approvals, Q&A history.

### Current Reasoning Pipeline

The **Think Node** (`orchestrator.py:561-1084`) is the brain:
1. Formats execution trace with objective grouping
2. Builds system prompt with current phase context, available tools, trace history, todo list, target info, Q&A history
3. Optionally injects pending output analysis section
4. Calls LLM → gets structured JSON (`LLMDecision` schema: thought, reasoning, action, tool_name, tool_args, etc.)
5. Parses response via `try_parse_llm_decision()`

### Current Strengths
- Phase-aware tool execution (informational → exploitation → post_exploitation)
- LLM-managed todo list with priorities
- Multi-objective support with objective history
- Attack path classification (CVE exploit vs brute force)
- Target info accumulation and merging
- Inline failure loop detection (3+ consecutive failures triggers warning)
- Output analysis with structured extraction (ports, services, vulns, credentials, sessions)

### Current Gaps (What We Can Improve)
| Gap | Impact |
|-----|--------|
| Single reasoning path per iteration (no branching/backtracking) | Misses alternative attack vectors |
| No explicit "deep think" step (thinking is embedded in the action decision) | Shallow reasoning on complex decisions |
| No self-verification of findings | False positives waste time |
| No learning from past sessions | Repeats mistakes across engagements |
| ~~No parallel tool execution~~ | ~~Slow reconnaissance phase~~ — **Resolved**: Wave execution runs independent tools in parallel via `asyncio.gather()` (`execute_plan` node) |
| Static prompt structure (same context regardless of complexity) | Token waste on easy tasks, insufficient context on hard ones |
| No dedicated planning phase (todo list is lightweight) | Gets lost in long engagements |
| No metacognitive awareness of reasoning quality | Perseverates on failing strategies |

---

## 2. Tier 1: Immediate Wins

> Low implementation complexity, high impact. These can be added in days, not weeks.

---

### 2.1 Think Node / Inner Monologue

**What it is:** An explicit, dedicated reasoning step where the agent thinks deeply before committing to an action — a scratchpad that is NOT part of the action decision.

**Core Mechanism:**
Add a `think_deeply` node to the LangGraph before the existing `think` node. This node's output is a private scratchpad (not shown to user, not parsed for actions) where the LLM can freely reason: weigh alternatives, simulate outcomes, identify risks, and plan multi-step strategies.

```
initialize → think_deeply → think → [route] → execute_tool → think_deeply → ...
```

**How It Enhances RedAmon:**
- Before deciding "use metasploit_console with `search CVE-2021-44228`", the agent first reasons: *"The target is running Apache 2.4.49. Log4Shell affects Log4j, not Apache httpd. I should NOT search for Log4Shell — instead I should look for CVE-2021-41773 (path traversal). Let me also consider whether mod_cgi is enabled, which would make this RCE rather than just a file read."*
- Currently, `thought` and `reasoning` fields in `LLMDecision` are part of the action decision JSON, which constrains deep reasoning. A separate scratchpad removes this coupling.

**Implementation in RedAmon:**

```python
# New node in orchestrator.py graph builder (after line 323)
builder.add_node("think_deeply", self._think_deeply_node)

# New routing: initialize → think_deeply → think
builder.add_edge("initialize", "think_deeply")  # replaces direct initialize→think
builder.add_edge("think_deeply", "think")
builder.add_edge("execute_tool", "think_deeply")  # tool output goes to deep think first

async def _think_deeply_node(self, state: AgentState, config=None) -> dict:
    """
    Deep reasoning scratchpad.
    The LLM reasons freely without being constrained to produce a structured action.
    Output is stored in state but NOT parsed for tool calls.
    """
    # Build context (trace, target_info, etc.)
    context = self._build_context(state)

    # If there's a pending tool output, include it for analysis
    pending_output = state.get("_tool_result", {}).get("output", "")

    prompt = f"""You are in DEEP THINKING mode. Reason freely about the current situation.
    DO NOT decide on an action yet. Instead:
    1. What do I know so far? (summarize key findings)
    2. What are my options? (list 2-4 possible next actions)
    3. What are the risks/tradeoffs of each option?
    4. What could go wrong? (anticipate failures)
    5. What is my confidence level? (low/medium/high)
    6. Am I stuck in a loop? (check if recent actions are repetitive)

    {f'TOOL OUTPUT TO ANALYZE: {pending_output[:5000]}' if pending_output else ''}

    Think step by step. Be honest about uncertainty."""

    response = await self.llm.ainvoke([SystemMessage(content=context), HumanMessage(content=prompt)])

    return {
        "_deep_thought": response.content,  # stored for think node to reference
    }
```

**New state field needed:** `_deep_thought: Optional[str]` in `AgentState`

**Complexity:** Low — one new node, one new state field, prompt engineering
**Impact:** Medium-High — prevents impulsive actions, catches reasoning errors before tool execution

---

### 2.2 Chain-of-Verification (CoVe)

**What it is:** After the agent makes a significant finding or conclusion, it generates verification questions about its own claims and independently answers them to catch errors.

**Core Mechanism:**
Insert a verification sub-loop after the output analysis step. When the agent claims "target is vulnerable to X" or "exploit succeeded", it must verify that claim before acting on it.

```python
# In _think_node, after output_analysis extraction (orchestrator.py ~line 854)

async def _verify_finding(self, finding: str, evidence: str) -> dict:
    """Chain-of-Verification: self-verify a finding before acting on it."""
    prompt = f"""You made this finding: "{finding}"
    Based on this evidence: "{evidence[:3000]}"

    Generate 3 verification questions, then answer each independently:
    1. [Question about factual accuracy]
    2. [Question about evidence quality]
    3. [Question about alternative explanations]

    For each question, answer with CONFIRMED, UNCERTAIN, or REFUTED.
    Then give an overall verdict: VERIFIED or NEEDS_MORE_EVIDENCE."""

    response = await self.llm.ainvoke([HumanMessage(content=prompt)])
    return {"verification": response.content, "verdict": "VERIFIED" in response.content.upper()}
```

**How It Enhances RedAmon:**
After the agent concludes "SQL injection on /api/users?id=1":
- Q1: *"Was the injection confirmed with a time-based or error-based test?"* → Check tool output for actual confirmation
- Q2: *"Could the observed behavior be a false positive (e.g., application error, not SQL error)?"* → Evaluate evidence quality
- Q3: *"Is the DBMS confirmed? Are the error messages consistent?"* → Cross-check findings

**When to Trigger:** Only for significant findings — vulnerability discovery, exploit success, credential discovery. NOT for routine tool calls.

```python
VERIFICATION_TRIGGERS = [
    "vulnerability", "CVE", "exploit_succeeded", "credential",
    "session", "RCE", "injection", "bypass"
]

def should_verify(self, output_analysis: OutputAnalysisInline) -> bool:
    """Check if this finding warrants verification."""
    if output_analysis.exploit_succeeded:
        return True
    text = output_analysis.interpretation.lower()
    return any(trigger in text for trigger in VERIFICATION_TRIGGERS)
```

**Complexity:** Low-Medium — prompt engineering + conditional verification step
**Impact:** High — false positive reduction is one of the most impactful improvements for pentesting. Reduces wasted time on non-existent vulns.

---

### 2.3 Tool-Use Planning

> **Status: IMPLEMENTED** — Wave execution is live. The LLM can emit `action: "plan_tools"` with a `ToolPlan` containing multiple independent steps. The `execute_plan` node runs them in parallel via `asyncio.gather()`, and the think node analyzes all outputs together. See [README.PENTEST_AGENT.md — Wave Execution](README.PENTEST_AGENT.md#wave-execution-parallel-tool-plans) for full details.

**What it is:** Before executing the first tool in a phase, the agent explicitly plans which tools to use, in what order, and which can run in parallel.

**Core Mechanism:**
The `plan_tools` action type in `LLMDecision` lets the agent generate a tool execution plan. When the LLM identifies independent tools, it emits a `ToolPlan` with steps that execute concurrently.

```python
# New action type in state.py
ActionType = Literal["use_tool", "plan_tools", "transition_phase", "complete", "ask_user"]

# New schema
class ToolPlan(BaseModel):
    """Planned sequence of tool executions."""
    steps: List[ToolPlanStep]

class ToolPlanStep(BaseModel):
    tool_name: str
    tool_args: dict
    depends_on: List[int] = []  # indices of steps that must complete first
    can_parallel: bool = False  # True if this can run alongside other parallel steps
    rationale: str
```

**Example Plan (Reconnaissance):**
```json
{
  "steps": [
    {"tool_name": "nmap_scan", "tool_args": {"target": "192.168.1.5", "args": "-sV -sC"},
     "depends_on": [], "can_parallel": true, "rationale": "Port & service discovery"},
    {"tool_name": "query_graph", "tool_args": {"question": "What do we know about 192.168.1.5?"},
     "depends_on": [], "can_parallel": true, "rationale": "Check existing recon data"},
    {"tool_name": "nuclei_scan", "tool_args": {"target": "http://192.168.1.5"},
     "depends_on": [0], "can_parallel": false, "rationale": "Vuln scan needs port info first"},
    {"tool_name": "web_search", "tool_args": {"query": "CVEs for {services_from_step_0}"},
     "depends_on": [0], "can_parallel": true, "rationale": "Research CVEs for discovered services"}
  ]
}
```

**How It Enhances RedAmon:**
- Steps 0 and 1 run in parallel (no dependencies)
- Steps 2 and 3 wait for step 0, then run in parallel
- Total time: ~2 sequential phases instead of 4 sequential steps
- The agent avoids redundant scans (checks graph first)
- Dependencies prevent ordering errors (e.g., vuln scan before port discovery)

**Complexity:** Low-Medium — new action type, dependency graph logic
**Impact:** Medium-High — reduces tool execution time by 2-3x during reconnaissance

---

### 2.4 System 1 / System 2 Thinking

**What it is:** Dual-process reasoning where the agent uses "fast" (System 1) reasoning for routine tasks and "slow" (System 2) deep reasoning for complex decisions.

**Core Mechanism:**
A complexity classifier routes between two processing modes:

```python
class ReasoningMode(Literal["fast", "deep"]):
    pass

def classify_complexity(self, state: AgentState) -> ReasoningMode:
    """Decide whether this situation needs deep or fast reasoning."""
    # Fast indicators: well-known services, standard tools, clear next step
    # Deep indicators: custom apps, ambiguous findings, multiple attack vectors, failures

    recent_failures = sum(1 for s in state["execution_trace"][-5:] if not s.get("success"))
    unique_services = len(set(state["target_info"].get("services", [])))
    iteration = state["current_iteration"]

    if recent_failures >= 2:
        return "deep"  # Failures need deeper thinking
    if unique_services > 5:
        return "deep"  # Complex target landscape
    if state["current_phase"] == "exploitation":
        return "deep"  # Exploitation always needs careful thought
    if iteration <= 3:
        return "fast"  # Early recon is usually straightforward

    return "fast"
```

**Two Modes:**

| Aspect | System 1 (Fast) | System 2 (Deep) |
|--------|-----------------|------------------|
| Think node | Single LLM call, concise prompt | Multi-pass: scratchpad → alternatives → decision |
| Temperature | 0.0 (deterministic) | 0.3-0.7 (explore alternatives) |
| Prompt size | Minimal context (last 3 steps) | Full context (all steps + target info) |
| Verification | Skip CoVe | Always run CoVe on findings |
| Token budget | ~500 tokens for thought | ~2000 tokens for thought |

**How It Enhances RedAmon:**
- "Port 22 open running OpenSSH 8.2" → System 1: *"Standard SSH, try default creds or known CVEs"*
- "Custom Java app on port 9443 with non-standard auth" → System 2: *"Let me analyze the auth flow, check for deserialization, examine headers for framework clues, consider SSRF via URL params..."*
- Saves 50-70% of tokens on routine tasks while investing deeply where it matters

**Complexity:** Medium — complexity classifier + two prompt paths
**Impact:** High — optimizes the efficiency/thoroughness tradeoff

---

### 2.5 Self-Consistency Voting

**What it is:** For critical decisions, sample multiple independent reasoning paths and select the most frequent conclusion via majority vote.

**Core Mechanism:**
```python
async def decide_with_consistency(self, state: AgentState, n_samples: int = 3) -> LLMDecision:
    """Sample N reasoning paths and vote on the best action."""
    decisions = []
    for _ in range(n_samples):
        # Same prompt, temperature > 0 for diversity
        decision = await self._get_llm_decision(state, temperature=0.5)
        decisions.append(decision)

    # Vote on action type + tool_name combination
    from collections import Counter
    action_votes = Counter((d.action, d.tool_name) for d in decisions)
    best_action, best_tool = action_votes.most_common(1)[0][0]

    # Return the decision that matches the majority and has the best reasoning
    matching = [d for d in decisions if d.action == best_action and d.tool_name == best_tool]
    return max(matching, key=lambda d: len(d.reasoning))  # pick most detailed reasoning
```

**When to Use:** Only for high-stakes decisions:
- Phase transitions (informational → exploitation)
- Choosing between multiple attack vectors
- Deciding whether an exploit succeeded
- Final vulnerability classification

**How It Enhances RedAmon:**
When classifying "Is this XSS stored or reflected?", 3 independent reasoning chains reduce misclassification. When deciding "Should I exploit CVE-2021-41773 or try brute force?", voting prevents committing to a suboptimal path based on a single reasoning chain.

**Complexity:** Low — run the same LLM call N times with temperature, vote
**Impact:** Medium — high for classification/decision tasks, marginal for sequential execution

---

## 3. Tier 2: High-Value Investments

> Medium implementation complexity, high impact. These are the core upgrades that transform the agent's capabilities.

---

### 3.1 Hierarchical Planning (Plan-and-Act)

**What it is:** Separate high-level strategic planning from low-level tactical execution using distinct Planner and Executor components.

**Core Mechanism:**
Replace the flat ReAct loop with a two-level hierarchy:

```
                    ┌─────────────────┐
                    │     PLANNER     │  (Strategic: sets milestones, tracks progress)
                    │  "What to do"   │
                    └────────┬────────┘
                             │ Plan / Replan
                    ┌────────▼────────┐
                    │    EXECUTOR     │  (Tactical: standard ReAct loop)
                    │  "How to do it" │
                    └────────┬────────┘
                             │ Status update
                    ┌────────▼────────┐
                    │    PLANNER      │  (Evaluate: are we on track?)
                    └─────────────────┘
```

**Planner LLM (separate from executor):**
```python
class StrategicPlan(BaseModel):
    """High-level engagement plan."""
    goal: str
    milestones: List[Milestone]
    current_milestone_index: int = 0
    contingency_plans: List[ContingencyPlan] = []

class Milestone(BaseModel):
    name: str
    description: str
    success_criteria: str  # How to know this milestone is complete
    estimated_tools: List[str]  # Tools likely needed
    max_iterations: int = 10  # Budget for this milestone
    status: Literal["pending", "in_progress", "completed", "failed"] = "pending"

class ContingencyPlan(BaseModel):
    trigger: str  # "If SQL injection fails..."
    alternative: str  # "...try file upload bypass"
```

**Example Plan for "Compromise web server at 192.168.1.5":**
```json
{
  "goal": "Gain shell access to 192.168.1.5",
  "milestones": [
    {
      "name": "Reconnaissance",
      "description": "Identify services, technologies, and potential attack vectors",
      "success_criteria": "Have complete list of open ports, services, and at least 1 potential vulnerability",
      "estimated_tools": ["nmap_scan", "query_graph", "nuclei_scan"],
      "max_iterations": 5
    },
    {
      "name": "Vulnerability Identification",
      "description": "Confirm exploitable vulnerabilities",
      "success_criteria": "At least 1 confirmed exploitable vulnerability with known exploit",
      "estimated_tools": ["nuclei_scan", "web_search", "query_graph"],
      "max_iterations": 8
    },
    {
      "name": "Exploitation",
      "description": "Exploit confirmed vulnerability to gain access",
      "success_criteria": "Active shell or meterpreter session established",
      "estimated_tools": ["metasploit_console"],
      "max_iterations": 10
    }
  ],
  "contingency_plans": [
    {"trigger": "No web vulnerabilities found", "alternative": "Pivot to SSH brute force"},
    {"trigger": "WAF blocking all exploits", "alternative": "Try alternative CVEs or social engineering vector"}
  ]
}
```

**Replanning Logic:**
```python
async def _planner_check(self, state: AgentState) -> dict:
    """Planner evaluates executor progress and decides whether to replan."""
    current_milestone = self.plan.milestones[self.plan.current_milestone_index]

    if current_milestone.iterations_used >= current_milestone.max_iterations:
        # Budget exceeded — force replanning
        return await self._replan(state, reason="milestone_budget_exceeded")

    if self._detect_stuck(state, threshold=3):
        # 3 iterations with no progress — consider contingency
        return await self._activate_contingency(state)

    return {}  # Continue with current plan
```

**How It Enhances RedAmon:**
- Prevents "lost in the weeds" — the planner maintains strategic direction
- Enables contingency planning — if primary path fails, automatically switches
- Budget enforcement — prevents spending 50 iterations on reconnaissance when exploitation should start
- The existing `todo_list` in `AgentState` can be upgraded to this milestone system

**Integration with current code:**
- Replace the flat `todo_list` with `strategic_plan` in `AgentState`
- Add `_planner_check` as a conditional node before `think`
- The `think` node becomes the Executor, constrained to the current milestone's scope

**Complexity:** Medium — two-level architecture, replanning logic
**Impact:** High — the single most impactful change for long-running engagements

---

### 3.2 Reflexion (Learning from Failures)

**What it is:** After a failed tool execution or objective, the agent generates a natural language reflection analyzing what went wrong and stores it for future retrieval.

**Core Mechanism:**

```python
class ReflectionEntry(BaseModel):
    """A lesson learned from a failed attempt."""
    reflection_id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    timestamp: datetime
    context: str  # What was the situation
    action_taken: str  # What the agent did
    outcome: str  # What happened (failure details)
    root_cause: str  # Why it failed
    lesson: str  # What to do differently next time
    tags: List[str]  # For retrieval: ["sqlmap", "waf", "mysql", "timeout"]
    target_technology: Optional[str]  # e.g., "Apache 2.4.49"

class ReflectionMemory:
    """Persistent store for agent reflections."""

    def __init__(self, storage_path: str = "/app/data/reflections"):
        self.storage_path = storage_path
        self.reflections: List[ReflectionEntry] = self._load()

    async def generate_reflection(self, state: AgentState, llm) -> ReflectionEntry:
        """Ask the LLM to reflect on a failure."""
        recent_steps = state["execution_trace"][-5:]
        failed_step = next((s for s in reversed(recent_steps) if not s.get("success")), None)

        if not failed_step:
            return None

        prompt = f"""A tool execution failed. Reflect on what went wrong.

        Tool: {failed_step.get('tool_name')}
        Args: {failed_step.get('tool_args')}
        Error: {failed_step.get('error_message')}
        Context: Phase={state['current_phase']}, Target={state['target_info'].get('primary_target')}

        Provide:
        1. ROOT CAUSE: Why did this fail? (be specific)
        2. LESSON: What should I do differently next time?
        3. TAGS: Keywords for future retrieval (comma-separated)"""

        response = await llm.ainvoke([HumanMessage(content=prompt)])
        # Parse into ReflectionEntry...
        return reflection

    def retrieve_relevant(self, context: str, tags: List[str], top_k: int = 3) -> List[ReflectionEntry]:
        """Retrieve reflections relevant to current situation."""
        # Simple tag-based matching (upgrade to vector similarity later)
        scored = []
        for r in self.reflections:
            score = len(set(r.tags) & set(tags))
            if score > 0:
                scored.append((score, r))
        scored.sort(reverse=True, key=lambda x: x[0])
        return [r for _, r in scored[:top_k]]
```

**Integration into Think Node:**
```python
# In _think_node (orchestrator.py), before building the system prompt:

relevant_reflections = self.reflection_memory.retrieve_relevant(
    context=current_objective,
    tags=extract_tags(state["target_info"])  # ["apache", "2.4.49", "http", "linux"]
)

if relevant_reflections:
    reflection_text = "\n".join([
        f"PAST LESSON: When {r.context}, I tried {r.action_taken} and it failed because {r.root_cause}. "
        f"Next time: {r.lesson}"
        for r in relevant_reflections
    ])
    # Inject into system prompt
    system_prompt += f"\n\n## LESSONS FROM PAST EXPERIENCE\n{reflection_text}"
```

**Example Reflection:**
```json
{
  "context": "Trying to exploit Apache 2.4.49 path traversal (CVE-2021-41773)",
  "action_taken": "Used metasploit module exploit/multi/http/apache_normalize_path_rce with default payload",
  "outcome": "Exploit failed — module requires mod_cgi to be enabled for RCE, target had mod_cgi disabled",
  "root_cause": "Did not verify mod_cgi was enabled before attempting RCE. The path traversal works for file read but RCE requires CGI.",
  "lesson": "Before attempting CVE-2021-41773 RCE, verify mod_cgi with curl to /cgi-bin/. If mod_cgi is disabled, use the file-read vector instead (directory_traversal module).",
  "tags": ["apache", "CVE-2021-41773", "mod_cgi", "path_traversal", "RCE"]
}
```

**How It Enhances RedAmon:**
- Agent accumulates pentesting expertise across sessions
- Never repeats the same mistake twice on similar targets
- Reflections can be shared across users/projects (anonymized)
- Storage can be as simple as a JSON file (Phase 1) or Neo4j/vector DB (Phase 2)

**Complexity:** Medium — reflection generation, storage, retrieval, prompt injection
**Impact:** High — transformative for an agent that encounters recurring patterns

---

### 3.3 Dynamic Prompt Assembly (Context Engineering)

**What it is:** Instead of a static system prompt, dynamically assemble the optimal context for each think step based on the current situation, available token budget, and what information is most relevant.

**Core Mechanism:**

The current system prompt in `prompts/base.py` (lines 183-438) is largely static. Replace it with a **context assembly engine**:

```python
class ContextAssembler:
    """Dynamically constructs the optimal prompt for each think step."""

    MAX_TOKENS = 12000  # Budget for system prompt

    def assemble(self, state: AgentState, reasoning_mode: str) -> str:
        """Build context from prioritized components."""
        components = []

        # 1. ALWAYS included: Core identity and current objective
        components.append(ContextComponent(
            name="identity",
            content=self._build_identity(state),
            priority=100,
            estimated_tokens=200
        ))

        # 2. ALWAYS: Current phase + available tools (but only current phase's tools)
        components.append(ContextComponent(
            name="phase_tools",
            content=build_tool_availability_table(state["current_phase"]),
            priority=95,
            estimated_tokens=500
        ))

        # 3. CONDITIONAL: Recent execution trace (last N depends on mode)
        trace_steps = 3 if reasoning_mode == "fast" else 10
        components.append(ContextComponent(
            name="execution_trace",
            content=format_execution_trace(state["execution_trace"], last_n=trace_steps),
            priority=90,
            estimated_tokens=trace_steps * 300
        ))

        # 4. CONDITIONAL: Target info (always in exploitation, summary in recon)
        if state["current_phase"] in ("exploitation", "post_exploitation"):
            components.append(ContextComponent(
                name="target_info",
                content=self._format_full_target_info(state["target_info"]),
                priority=85,
                estimated_tokens=400
            ))

        # 5. CONDITIONAL: Relevant reflections (if any match current context)
        reflections = self.reflection_memory.retrieve_relevant(...)
        if reflections:
            components.append(ContextComponent(
                name="reflections",
                content=self._format_reflections(reflections),
                priority=80,
                estimated_tokens=len(reflections) * 150
            ))

        # 6. CONDITIONAL: Attack path guidance (only when in exploitation)
        if state["current_phase"] == "exploitation":
            components.append(ContextComponent(
                name="attack_guidance",
                content=self._get_attack_path_guidance(state["attack_path_type"]),
                priority=75,
                estimated_tokens=800
            ))

        # 7. LOW PRIORITY: Q&A history, objective history
        components.append(ContextComponent(
            name="qa_history",
            content=format_qa_history(state.get("qa_history", [])),
            priority=30,
            estimated_tokens=200
        ))

        # Assemble within token budget
        components.sort(key=lambda c: c.priority, reverse=True)
        assembled = []
        tokens_used = 0
        for comp in components:
            if tokens_used + comp.estimated_tokens <= self.MAX_TOKENS:
                assembled.append(comp.content)
                tokens_used += comp.estimated_tokens

        return "\n\n".join(assembled)
```

**How It Enhances RedAmon:**
- System 1 mode: ~3000 tokens of context (fast, focused)
- System 2 mode: ~12000 tokens of context (comprehensive)
- Reflections and attack guidance are included when relevant, excluded when not
- Token budget never wasted on irrelevant sections
- The current static `REACT_SYSTEM_PROMPT` (183-438 in base.py) becomes a template with modular sections

**Complexity:** Medium — refactoring the prompt system into components, adding prioritization
**Impact:** High — Anthropic has stated "most agent failures are context failures, not model failures"

---

### 3.4 Critic / Verifier Agents

**What it is:** Dedicated agent instances whose sole purpose is to evaluate, critique, and verify the work of the main agent.

**Core Mechanism:**
Run a separate LLM instance (can be cheaper model) that reviews the main agent's decisions before they execute:

```python
class CriticAgent:
    """Dedicated critic for evaluating agent decisions."""

    def __init__(self, llm):
        self.llm = llm  # Can use a cheaper/faster model

    async def critique_decision(self, decision: LLMDecision, state: AgentState) -> CritiqueResult:
        """Evaluate a decision before execution."""
        prompt = f"""You are a SECURITY EXPERT reviewing an agent's decision.

        Current situation:
        - Target: {state['target_info'].get('primary_target')}
        - Phase: {state['current_phase']}
        - Recent actions: {self._summarize_recent(state)}

        Agent wants to execute:
        - Action: {decision.action}
        - Tool: {decision.tool_name}
        - Args: {decision.tool_args}
        - Reasoning: {decision.reasoning}

        Evaluate:
        1. Is this the RIGHT action given the current situation? (Yes/No + why)
        2. Are the arguments CORRECT? (Check for common mistakes)
        3. Is there a BETTER alternative? (If yes, what?)
        4. Is this IN SCOPE? (Check against target constraints)
        5. RISK LEVEL: Low/Medium/High (detection risk, destructiveness)

        Return: APPROVE, SUGGEST_MODIFICATION, or BLOCK"""

        response = await self.llm.ainvoke([HumanMessage(content=prompt)])
        return self._parse_critique(response.content)

class CritiqueResult(BaseModel):
    verdict: Literal["approve", "suggest_modification", "block"]
    reasoning: str
    suggested_modification: Optional[dict] = None  # Alternative args if modification suggested
    risk_level: Literal["low", "medium", "high"]
```

**Types of Critic Agents:**

| Critic | Focus | When Active |
|--------|-------|-------------|
| **Scope Checker** | Verifies target is in scope | Every tool execution |
| **Finding Verifier** | Validates vulnerability claims | After output analysis |
| **Strategy Critic** | Evaluates tactical decisions | Before exploitation attempts |
| **Stealth Auditor** | Checks detection risk | In stealth mode engagements |

**How It Enhances RedAmon:**
- Catches out-of-scope actions before they execute
- Validates findings before they enter reports
- Suggests better tool arguments (e.g., "use --tamper for WAF bypass")
- Low cost: critic LLM calls are short and can use faster models

**Complexity:** Medium — separate LLM instances, integration into decision pipeline
**Impact:** High — dedicated verification is one of the highest-ROI improvements

---

### 3.5 Meta-Cognition / Metacognitive Monitoring

**What it is:** The agent monitors its own reasoning process — detecting loops, assessing confidence, recognizing knowledge gaps, and triggering strategy changes.

**Core Mechanism:**
A `MetacognitiveMonitor` runs alongside the think node:

```python
class MetacognitiveMonitor:
    """Monitors agent reasoning and flags issues."""

    def analyze(self, state: AgentState) -> MetacognitiveReport:
        """Run all metacognitive checks."""
        return MetacognitiveReport(
            loop_detected=self._detect_loop(state),
            confidence_level=self._assess_confidence(state),
            knowledge_gap=self._detect_knowledge_gap(state),
            progress_stalled=self._check_progress(state),
            strategy_recommendation=self._recommend_strategy(state),
        )

    def _detect_loop(self, state: AgentState) -> Optional[str]:
        """Detect repetitive action patterns."""
        recent = state["execution_trace"][-6:]
        tool_sequence = [s.get("tool_name") for s in recent]

        # Check for exact repeats: [nmap, nmap, nmap]
        if len(set(tool_sequence[-3:])) == 1 and len(tool_sequence) >= 3:
            return f"LOOP: Same tool ({tool_sequence[-1]}) used 3+ times consecutively"

        # Check for oscillation: [nmap, gobuster, nmap, gobuster]
        if len(tool_sequence) >= 4:
            if tool_sequence[-4:-2] == tool_sequence[-2:]:
                return f"OSCILLATION: Alternating between {tool_sequence[-2]} and {tool_sequence[-1]}"

        return None

    def _assess_confidence(self, state: AgentState) -> float:
        """Estimate agent's confidence based on recent success/failure ratio."""
        recent = state["execution_trace"][-5:]
        if not recent:
            return 0.5

        success_rate = sum(1 for s in recent if s.get("success")) / len(recent)
        findings_count = len(state["target_info"].get("vulnerabilities", []))

        # Confidence = f(success_rate, findings, iteration)
        return min(1.0, success_rate * 0.6 + (min(findings_count, 3) / 3) * 0.4)

    def _detect_knowledge_gap(self, state: AgentState) -> Optional[str]:
        """Detect when the agent lacks knowledge to proceed."""
        recent_errors = [s.get("error_message", "") for s in state["execution_trace"][-3:] if s.get("error_message")]

        # Pattern: repeated "unknown module" or "command not found" errors
        unknown_patterns = ["unknown", "not found", "no results", "invalid"]
        if any(any(p in err.lower() for p in unknown_patterns) for err in recent_errors):
            return "KNOWLEDGE_GAP: Agent appears to be guessing. Consider web search or asking user."

        return None

    def _recommend_strategy(self, state: AgentState) -> str:
        """Recommend strategy change based on metacognitive analysis."""
        loop = self._detect_loop(state)
        confidence = self._assess_confidence(state)
        gap = self._detect_knowledge_gap(state)

        if loop:
            return "CHANGE_STRATEGY: Break the loop. Try a completely different approach."
        if confidence < 0.3:
            return "ESCALATE: Low confidence. Gather more information or ask the user."
        if gap:
            return "RESEARCH: Use web_search to fill knowledge gap before proceeding."

        return "CONTINUE: On track."
```

**Integration:**
```python
# In _think_node, before LLM call:
metacog = self.metacognitive_monitor.analyze(state)

if metacog.loop_detected:
    system_prompt += f"\n\n⚠️ METACOGNITIVE WARNING: {metacog.loop_detected}\n{metacog.strategy_recommendation}"
if metacog.confidence_level < 0.3:
    system_prompt += f"\n\n⚠️ LOW CONFIDENCE ({metacog.confidence_level:.0%}): {metacog.strategy_recommendation}"
```

**How It Enhances RedAmon:**
- Breaks the #1 failure mode: perseveration on failing strategies
- Currently, `orchestrator.py` has basic failure loop detection (lines 642-671 of base.py) — this is a much richer version
- Confidence tracking enables System 1/2 routing
- Knowledge gap detection triggers web search or user escalation

**Complexity:** Medium — analysis logic + integration into think node
**Impact:** High — metacognition prevents the most common ReAct loop failures

---

### 3.6 Experience Replay / Episodic Memory

**What it is:** Store structured records of past engagements (tools used, strategies that worked/failed, findings) and retrieve relevant experiences when facing similar targets.

**Core Mechanism:**

```python
class Episode(BaseModel):
    """A complete engagement episode for memory."""
    episode_id: str
    timestamp: datetime
    target_summary: TargetInfo  # Technology stack, services
    objective: str
    strategy_used: str  # e.g., "CVE exploitation via Metasploit"
    tools_sequence: List[str]  # Ordered tool calls
    outcome: Literal["success", "partial", "failure"]
    key_findings: List[str]
    duration_iterations: int
    reflections: List[str]  # Lessons learned

class EpisodicMemory:
    """Long-term memory of past engagements."""

    def __init__(self, neo4j_driver=None):
        """Can use Neo4j (already in RedAmon stack) or simple file storage."""
        self.driver = neo4j_driver

    async def store_episode(self, state: AgentState):
        """Store completed engagement as an episode."""
        episode = Episode(
            episode_id=state["session_id"],
            timestamp=datetime.now(),
            target_summary=TargetInfo(**state["target_info"]),
            objective=state["conversation_objectives"][-1].get("content", ""),
            strategy_used=state["attack_path_type"],
            tools_sequence=[s.get("tool_name") for s in state["execution_trace"] if s.get("tool_name")],
            outcome=self._classify_outcome(state),
            key_findings=state["target_info"].get("vulnerabilities", []),
            duration_iterations=state["current_iteration"],
            reflections=[]  # Filled by Reflexion system
        )

        if self.driver:
            # Store in Neo4j — leverage existing graph infrastructure
            await self._store_neo4j(episode)

    async def recall(self, target_info: TargetInfo, objective: str, top_k: int = 3) -> List[Episode]:
        """Find similar past engagements."""
        # Match by technology stack overlap
        if self.driver:
            query = """
            MATCH (e:Episode)
            WHERE any(tech IN $technologies WHERE tech IN e.technologies)
               OR any(svc IN $services WHERE svc IN e.services)
            RETURN e ORDER BY e.timestamp DESC LIMIT $top_k
            """
            return await self._query_neo4j(query, {
                "technologies": target_info.technologies,
                "services": target_info.services,
                "top_k": top_k
            })
```

**Neo4j Integration (already in the stack):**
Since RedAmon already uses Neo4j for recon data, store episodes as graph nodes:

```cypher
CREATE (e:Episode {
  episode_id: $id,
  target: $target,
  outcome: "success",
  strategy: "cve_exploit"
})
CREATE (e)-[:USED_TOOL]->(:Tool {name: "metasploit_console"})
CREATE (e)-[:EXPLOITED]->(:Vulnerability {cve: "CVE-2021-41773"})
CREATE (e)-[:TARGETED]->(:Technology {name: "Apache 2.4.49"})
```

**How It Enhances RedAmon:**
- *"I've seen Apache 2.4.49 before — last time CVE-2021-41773 worked after verifying mod_cgi. Let me check that first."*
- Agent gets faster on recurring target types
- Can surface patterns: *"7 out of 10 WordPress 5.8 targets were vulnerable to WPForms plugin exploit"*
- Uses existing Neo4j infrastructure — no new databases needed

**Complexity:** Medium — episode extraction, storage, similarity-based retrieval
**Impact:** High — transforms agent from stateless to experienced

---

### 3.7 RAG-Enhanced Reasoning

**What it is:** Dynamically retrieve relevant knowledge (CVE details, exploit techniques, tool documentation) from a curated knowledge base during reasoning.

**Core Mechanism:**

RedAmon already has Tavily web search (`tools.py:402-481`). RAG adds a **local, curated** knowledge base for faster, more reliable retrieval:

```python
class PentestKnowledgeBase:
    """Vector-indexed pentesting knowledge for retrieval."""

    SOURCES = [
        "exploit-db entries",
        "NVD CVE database",
        "OWASP Testing Guide",
        "tool documentation (Metasploit, Nmap, Nuclei, Hydra)",
        "HackerOne disclosed reports",
        "past engagement reflections"
    ]

    def __init__(self, vector_store):
        self.store = vector_store  # FAISS, ChromaDB, or Pinecone

    async def query(self, question: str, filters: dict = None, top_k: int = 5) -> List[Document]:
        """Retrieve relevant knowledge for the agent's current question."""
        results = await self.store.similarity_search(
            query=question,
            k=top_k,
            filter=filters  # e.g., {"technology": "Apache", "type": "exploit"}
        )
        return results

    async def adaptive_retrieve(self, state: AgentState, question: str) -> str:
        """Adaptive RAG: determine retrieval depth based on question complexity."""
        # Simple questions (known CVEs): single retrieval
        # Complex questions (custom apps): iterative multi-source retrieval

        complexity = self._assess_query_complexity(question, state)

        if complexity == "simple":
            docs = await self.query(question, top_k=3)
            return self._format_docs(docs)
        elif complexity == "complex":
            # Iterative: retrieve, reason, retrieve more
            docs = await self.query(question, top_k=5)
            gaps = self._identify_knowledge_gaps(docs, question)
            for gap in gaps:
                additional = await self.query(gap, top_k=3)
                docs.extend(additional)
            return self._format_docs(docs)
```

**Integration with existing Tavily search:**
```python
# In tools.py, upgrade tavily_search to use local KB first:
async def enhanced_search(query: str, state: AgentState) -> str:
    # 1. Check local knowledge base first (fast, reliable)
    local_results = await knowledge_base.query(query, top_k=3)

    if local_results and self._is_sufficient(local_results, query):
        return format_results(local_results)

    # 2. Fall back to Tavily web search (slower, more current)
    web_results = await tavily_search(query)

    # 3. Merge and deduplicate
    return merge_results(local_results, web_results)
```

**How It Enhances RedAmon:**
- Faster than web search for known CVEs and techniques
- More reliable than web search (curated, verified content)
- Can include tool-specific documentation (e.g., exact Metasploit module syntax)
- Provides context that the LLM may not have in training data (recent CVEs, niche exploits)

**Complexity:** Medium — vector store setup, document ingestion pipeline, retrieval integration
**Impact:** High — bridges the knowledge gap that no LLM can fully cover

---

### 3.8 Parallel Agent Architectures

**What it is:** Multiple agent instances work simultaneously on different aspects of a task, with results aggregated by a synthesizer.

**Core Mechanism:**
Implement a **fan-out/fan-in** pattern for the reconnaissance phase:

```
                    ┌────────────────────┐
                    │   ORCHESTRATOR     │
                    │ (decompose target) │
                    └─────────┬──────────┘
                              │ fan-out
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
    ┌─────────────┐  ┌──────────────┐  ┌──────────────┐
    │ Port Scanner │  │ Web Fingerpr │  │ Vuln Scanner │
    │    Agent     │  │    Agent     │  │    Agent     │
    └──────┬──────┘  └──────┬───────┘  └──────┬───────┘
           │                │                  │
           └────────────────┼──────────────────┘
                            │ fan-in
                   ┌────────▼────────┐
                   │   SYNTHESIZER   │
                   │ (correlate all  │
                   │  findings)      │
                   └─────────────────┘
```

**Implementation using Python asyncio (already in the stack):**

```python
class ParallelReconOrchestrator:
    """Orchestrates parallel reconnaissance agents."""

    async def run_parallel_recon(self, target: str, state: AgentState) -> dict:
        """Fan out reconnaissance tasks, fan in results."""

        # Define parallel tasks
        tasks = [
            self._run_port_scan(target),
            self._run_web_fingerprint(target),
            self._run_dns_enumeration(target),
            self._run_graph_query(target, state),
        ]

        # Fan out — all run concurrently
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Fan in — synthesize findings
        synthesized = await self._synthesize_results(results, state)
        return synthesized

    async def _synthesize_results(self, results: List, state: AgentState) -> dict:
        """Use LLM to correlate findings from all agents."""
        prompt = f"""You are a security analyst synthesizing reconnaissance results.

        Port Scan Results: {results[0]}
        Web Fingerprint Results: {results[1]}
        DNS Enumeration Results: {results[2]}
        Graph Query Results: {results[3]}

        Correlate these findings:
        1. What is the target's technology stack?
        2. What are the most promising attack vectors? (ranked)
        3. What additional information is needed?
        4. Recommend the next phase of testing."""

        response = await self.llm.ainvoke([HumanMessage(content=prompt)])
        return {"synthesis": response.content, "raw_results": results}
```

**How It Enhances RedAmon:**
- Reconnaissance time reduced by 3-4x (parallel tool execution)
- Cross-correlation catches patterns that sequential analysis misses
- The synthesizer can spot connections: *"Port 8443 runs Apache Tomcat, and the subdomain admin.target.com resolves to the same IP — this is likely the management interface"*

**Implementation Notes:**
- RedAmon's MCP tools already support concurrent execution
- The existing `execute_with_progress()` in `tools.py:632-720` handles streaming for long tools
- Docker container can handle multiple MCP connections

**Complexity:** Medium — asyncio fan-out/fan-in, synthesizer LLM call
**Impact:** High — dramatic speed improvement + better finding correlation

---

## 4. Tier 3: Strategic Investments

> High implementation complexity, high impact. These are the advanced techniques that push the agent toward frontier reasoning capabilities.

---

### 4.1 Tree-of-Thought (ToT)

**What it is:** Instead of a single reasoning path, the agent explores a tree of intermediate "thoughts", evaluating branches and using search (BFS/DFS) to find the best strategy.

**Core Mechanism:**

```
                    "Target has ports 80, 22, 3306 open"
                    /              |              \
             Web Attack      SSH Attack      MySQL Attack
            /     \            /    \           /     \
        SQLi    XSS      Brute   CVE      Brute    UDF
        /  \     |       Force  Exploit    Force   Exploit
    Union Blind  ...      ...    ...       ...      ...

    [Each node is evaluated and scored. Best path is pursued.]
```

```python
class ThoughtNode:
    """A node in the thought tree."""
    thought: str  # The reasoning at this node
    action_plan: str  # What this path would do next
    score: float  # LLM-evaluated quality (0-1)
    children: List["ThoughtNode"]
    parent: Optional["ThoughtNode"]

class TreeOfThought:
    """ToT reasoning engine for attack vector selection."""

    def __init__(self, llm, max_breadth: int = 3, max_depth: int = 3):
        self.llm = llm
        self.max_breadth = max_breadth  # branches per node
        self.max_depth = max_depth

    async def explore(self, state: AgentState) -> ThoughtNode:
        """BFS exploration of thought tree."""
        root = ThoughtNode(
            thought=f"Target analysis: {self._summarize_target(state)}",
            action_plan="",
            score=0.5,
            children=[]
        )

        # Generate children
        children = await self._generate_thoughts(root, state)

        # Evaluate each child
        for child in children:
            child.score = await self._evaluate_thought(child, state)

        # Sort by score, expand top branches
        children.sort(key=lambda c: c.score, reverse=True)
        root.children = children[:self.max_breadth]

        # Recurse on best branches
        for child in root.children:
            if child.score > 0.4:  # Only expand promising branches
                grandchildren = await self._generate_thoughts(child, state)
                for gc in grandchildren:
                    gc.score = await self._evaluate_thought(gc, state)
                child.children = sorted(grandchildren, key=lambda c: c.score, reverse=True)[:self.max_breadth]

        # Return best leaf node (highest cumulative score path)
        return self._best_path(root)

    async def _generate_thoughts(self, parent: ThoughtNode, state: AgentState) -> List[ThoughtNode]:
        """Generate candidate thoughts (branches) from a parent node."""
        prompt = f"""Given this analysis: {parent.thought}
        And target info: {state['target_info']}

        Generate {self.max_breadth} DIFFERENT possible next steps.
        Each should be a distinct approach/strategy.
        For each, provide:
        - thought: Your reasoning for this approach
        - action_plan: What specific tools/actions you would take"""

        response = await self.llm.ainvoke([HumanMessage(content=prompt)])
        return self._parse_thoughts(response.content, parent)

    async def _evaluate_thought(self, node: ThoughtNode, state: AgentState) -> float:
        """Score a thought node (0-1) based on feasibility and impact."""
        prompt = f"""Rate this pentesting strategy on a scale of 0-1:
        Strategy: {node.thought}
        Action plan: {node.action_plan}
        Target context: {state['target_info']}

        Consider:
        - Feasibility (can this actually work given the target?)
        - Impact (what access/info would this provide?)
        - Efficiency (how many steps/time required?)
        - Risk (detection probability, destructiveness)

        Return ONLY a number between 0 and 1."""

        response = await self.llm.ainvoke([HumanMessage(content=prompt)])
        try:
            return float(response.content.strip())
        except ValueError:
            return 0.5
```

**When to Use ToT in RedAmon:**
- At the start of exploitation phase (choose attack vector)
- When current strategy has failed 3+ times (explore alternatives)
- When target has multiple potential entry points (complex targets)

NOT for routine actions (standard nmap, simple tool calls).

**How It Enhances RedAmon:**
- Prevents commitment to suboptimal attack paths
- Explicit evaluation of alternatives before execution
- Backtracking when a path proves unproductive
- The existing single-path think node becomes one strategy within the tree

**Complexity:** High — tree data structure, generation + evaluation LLM calls, search algorithm
**Impact:** High — especially for complex targets where the right attack vector is non-obvious

---

### 4.2 Graph-of-Thought (GoT)

**What it is:** Reasoning modeled as a DAG (Directed Acyclic Graph) where thoughts can merge, aggregate, and form complex dependency structures — extending ToT with graph operations.

**Core Mechanism:**

Unlike ToT (tree = branches diverge only), GoT allows:
- **Aggregation:** Merge findings from SQL injection path + directory brute force path → combined attack strategy
- **Refinement:** Improve a thought in-place based on new evidence
- **Loop-back:** A later finding informs an earlier hypothesis

```
    Port Scan ──────────┐
         │              │
    Web Fingerprint     │
         │              ▼
    SQLi Detection   Credential Found
         │              │
         └──────┬───────┘
                ▼
        MERGE: Use credential on SQLi endpoint
                │
                ▼
        Authenticated SQLi → DB dump → Pivot
```

```python
class ThoughtGraph:
    """DAG-structured reasoning with merge and refine operations."""

    def __init__(self):
        self.nodes: Dict[str, GoTNode] = {}
        self.edges: List[Tuple[str, str]] = []  # (from_id, to_id)

    def add_thought(self, content: str, depends_on: List[str] = []) -> str:
        node = GoTNode(id=uuid4(), content=content, status="pending")
        self.nodes[node.id] = node
        for dep in depends_on:
            self.edges.append((dep, node.id))
        return node.id

    def merge_thoughts(self, node_ids: List[str], merged_content: str) -> str:
        """Aggregate multiple thoughts into one (GoT-specific operation)."""
        merged = GoTNode(
            id=uuid4(),
            content=merged_content,
            status="pending",
            merged_from=node_ids
        )
        self.nodes[merged.id] = merged
        for nid in node_ids:
            self.edges.append((nid, merged.id))
        return merged.id

    def refine_thought(self, node_id: str, new_evidence: str) -> str:
        """Refine a thought in place with new information."""
        node = self.nodes[node_id]
        node.content += f"\n[REFINED with: {new_evidence}]"
        node.refinement_count += 1
        return node_id
```

**Why GoT over ToT for pentesting:**
Pentesting is inherently graph-structured — findings from different tools/paths converge. Discovering credentials via SQL injection (path A) and finding an admin panel via directory enumeration (path B) naturally merge into "use credentials on admin panel" (path C).

**Complexity:** High — DAG data structure, merge/refine operations, scoring across graph
**Impact:** High — pentesting reasoning maps naturally to graph structures

---

### 4.3 Monte Carlo Tree Search (MCTS)

**What it is:** Applying MCTS (from AlphaGo) to guide agent reasoning — treat each reasoning step as a "move", simulate paths forward, and backpropagate success signals.

**Core Mechanism:**

```python
class MCTSReasoner:
    """MCTS for multi-step attack planning."""

    def __init__(self, llm, simulations: int = 50):
        self.llm = llm
        self.simulations = simulations
        self.tree = MCTSTree()

    async def search(self, state: AgentState) -> str:
        """Run MCTS to find best next action."""
        root = self.tree.root(state)

        for _ in range(self.simulations):
            # 1. SELECT: Traverse tree using UCB1
            node = self._select(root)

            # 2. EXPAND: Generate new reasoning step via LLM
            child = await self._expand(node, state)

            # 3. SIMULATE: Roll out the reasoning path to completion
            reward = await self._simulate(child, state)

            # 4. BACKPROPAGATE: Update value estimates along path
            self._backpropagate(child, reward)

        # Return most-visited child (best action)
        return self._best_child(root).action

    async def _simulate(self, node: MCTSNode, state: AgentState) -> float:
        """Simulate a complete attack path from this node."""
        prompt = f"""Starting from this state:
        {node.reasoning_so_far}

        Simulate the COMPLETE attack path forward. What would happen?
        Consider: tool success/failure, target response, detection risk.

        Rate the expected outcome: 0.0 (complete failure) to 1.0 (full compromise)."""

        response = await self.llm.ainvoke([HumanMessage(content=prompt)])
        try:
            return float(response.content.strip().split('\n')[-1])
        except ValueError:
            return 0.5

    def _select(self, node: MCTSNode) -> MCTSNode:
        """UCB1 selection: balance exploration and exploitation."""
        while node.children:
            node = max(node.children, key=lambda c: c.ucb1_score())
        return node
```

**Use Case in RedAmon:**
When the agent must construct a multi-step exploit chain:
1. Gain foothold → 2. Privilege escalation → 3. Lateral movement → 4. Data exfiltration

MCTS simulates each path forward:
- Path A: SQLi → web shell → sudo exploit → root
- Path B: SSH brute force → user shell → kernel exploit → root
- Path C: SSRF → internal service → pivot → domain admin

Each path is simulated and scored. The agent pursues the highest-scoring path.

**Complexity:** High — full MCTS implementation, rollout simulation, UCB1 scoring
**Impact:** High — principled exploration with theoretical convergence guarantees

---

### 4.4 Test-Time Compute (TTC)

**What it is:** Allocating variable amounts of compute at inference time based on problem difficulty. Easy problems get one LLM call; hard problems get many.

**Core Mechanism:**

```python
class TestTimeComputeAllocator:
    """Scales inference compute based on difficulty."""

    DIFFICULTY_THRESHOLDS = {
        "trivial": {"llm_calls": 1, "verify": False, "temperature": 0.0},
        "easy": {"llm_calls": 1, "verify": False, "temperature": 0.0},
        "medium": {"llm_calls": 3, "verify": True, "temperature": 0.3},
        "hard": {"llm_calls": 5, "verify": True, "temperature": 0.5},
        "expert": {"llm_calls": 10, "verify": True, "temperature": 0.7},
    }

    async def allocate_and_solve(self, state: AgentState, difficulty: str) -> LLMDecision:
        """Allocate compute based on difficulty, then solve."""
        config = self.DIFFICULTY_THRESHOLDS[difficulty]

        if config["llm_calls"] == 1:
            # Fast path: single call
            return await self._single_call(state, config["temperature"])

        # Multi-call path: generate N candidates, score, pick best
        candidates = []
        for _ in range(config["llm_calls"]):
            decision = await self._single_call(state, config["temperature"])
            score = await self._score_decision(decision, state)
            candidates.append((score, decision))

        # Pick highest-scored decision
        best_score, best_decision = max(candidates, key=lambda x: x[0])

        # Verify if required
        if config["verify"]:
            verification = await self._verify(best_decision, state)
            if not verification.passed:
                # Take second-best if verification fails
                candidates.remove((best_score, best_decision))
                if candidates:
                    _, best_decision = max(candidates, key=lambda x: x[0])

        return best_decision
```

**Difficulty Classification:**
```python
def classify_difficulty(self, state: AgentState) -> str:
    """Classify current decision difficulty."""
    phase = state["current_phase"]
    recent_failures = sum(1 for s in state["execution_trace"][-3:] if not s.get("success"))
    target_complexity = len(state["target_info"].get("services", []))

    if phase == "informational" and recent_failures == 0:
        return "easy"  # Standard recon
    if phase == "exploitation" and recent_failures >= 2:
        return "expert"  # Failing exploitation needs maximum compute
    if target_complexity > 5:
        return "hard"  # Complex target landscape
    if phase == "exploitation":
        return "medium"  # Exploitation needs care

    return "easy"
```

**Research basis:** Snell et al. (2024) showed that optimal test-time compute allocation achieves the same quality as a 14x larger model.

**Complexity:** High — difficulty classifier, multi-call generation, scoring function
**Impact:** High — 4x compute efficiency improvement over naive approaches

---

### 4.5 World Models / Mental Simulation

**What it is:** The agent maintains an internal model of the target environment and can "mentally simulate" actions before executing them.

**Core Mechanism:**

```python
class TargetWorldModel:
    """Internal representation of the target for mental simulation."""

    def __init__(self):
        self.services: Dict[int, ServiceModel] = {}  # port → service model
        self.waf_detected: bool = False
        self.waf_rules: List[str] = []  # Known WAF bypass rules
        self.auth_mechanisms: List[str] = []
        self.technology_stack: List[str] = []

    async def simulate_action(self, action: str, tool_args: dict, llm) -> SimulationResult:
        """Simulate an action against the world model BEFORE executing it."""
        prompt = f"""Given this target model:
        Services: {self.services}
        WAF: {self.waf_detected}, rules: {self.waf_rules}
        Tech stack: {self.technology_stack}

        Simulate this action: {action} with args {tool_args}

        Predict:
        1. LIKELY OUTCOME: What will probably happen?
        2. SUCCESS PROBABILITY: 0-100%
        3. DETECTION RISK: Low/Medium/High
        4. SIDE EFFECTS: Any unintended consequences?
        5. RECOMMENDATION: Proceed / Modify / Abort"""

        response = await llm.ainvoke([HumanMessage(content=prompt)])
        return self._parse_simulation(response.content)

    def update_from_observation(self, tool_output: str, analysis: OutputAnalysisInline):
        """Update world model based on actual tool output."""
        # Update services based on discovered ports/services
        for port, svc in zip(analysis.extracted_info.ports, analysis.extracted_info.services):
            self.services[port] = ServiceModel(name=svc, port=port)

        # Detect WAF from tool output
        if any(indicator in tool_output.lower() for indicator in ["waf", "blocked", "403 forbidden", "rate limit"]):
            self.waf_detected = True
```

**How It Enhances RedAmon:**
Before running an exploit:
- *"If I send this SQLi payload, the WAF will likely block it (detected Cloudflare). Success probability: 10%. Recommendation: Use --tamper=between,randomcase for WAF bypass. Modified success probability: 45%."*
- Prevents wasted attempts that increase detection risk
- Especially valuable for stealth operations

**Complexity:** High — maintaining an accurate world model that's useful for simulation
**Impact:** High — transformative for stealth operations and complex targets

---

## 5. Tier 4: Advanced Multi-Agent Patterns

> These techniques create a true multi-agent system, far beyond the single ReAct loop.

---

### 5.1 Multi-Agent Debate

**What it is:** Multiple LLM instances propose different attack strategies and debate them over multiple rounds to arrive at a consensus.

**Architecture:**

```
    ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
    │  ATTACKER   │   │  DEFENDER   │   │  STRATEGIST │
    │   Agent     │   │   Agent     │   │    Agent    │
    │ (aggressive │   │ (cautious,  │   │ (balanced,  │
    │  exploits)  │   │  stealth)   │   │  efficient) │
    └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
           │                 │                  │
           └─────────────────┼──────────────────┘
                             │ debate rounds
                    ┌────────▼────────┐
                    │   CONSENSUS     │
                    │   (vote/merge)  │
                    └─────────────────┘
```

**Debate Protocol:**
```python
async def debate(self, state: AgentState, rounds: int = 3) -> str:
    """Run multi-agent debate on strategy."""
    agents = [
        {"role": "attacker", "bias": "aggressive exploitation, maximum impact"},
        {"role": "defender", "bias": "stealth, avoid detection, minimize noise"},
        {"role": "strategist", "bias": "efficiency, cost-benefit analysis"},
    ]

    positions = {}
    for round_num in range(rounds):
        for agent in agents:
            # Each agent sees others' positions from previous round
            other_positions = {k: v for k, v in positions.items() if k != agent["role"]}

            prompt = f"""You are the {agent['role']} agent. Your bias: {agent['bias']}.
            Target: {state['target_info']}
            {"Other agents' positions: " + str(other_positions) if other_positions else ""}

            {"This is round " + str(round_num+1) + ". Refine your position based on others' arguments." if round_num > 0 else "State your initial position."}

            What attack strategy do you recommend and why?"""

            response = await self.llm.ainvoke([HumanMessage(content=prompt)])
            positions[agent["role"]] = response.content

    # Final consensus
    consensus = await self._find_consensus(positions)
    return consensus
```

**When to Use:** Before major strategic decisions (which attack path, when to escalate, risk assessment).

**Complexity:** Medium — multiple LLM instances, debate protocol
**Impact:** Medium — 2025 research shows simpler ensemble methods sometimes match debate, but the role-based adversarial aspect is valuable for risk assessment

---

### 5.2 Mixture of Agents (MoA)

**What it is:** A layered architecture where each layer contains multiple agents, and each agent uses all previous layer outputs as context for refinement.

```
    Layer 1: Independent Analysis
    ┌──────┐  ┌──────┐  ┌──────┐
    │Web   │  │Net   │  │Vuln  │
    │Expert│  │Expert│  │Expert│
    └──┬───┘  └──┬───┘  └──┬───┘
       │         │         │
    Layer 2: Cross-Expert Synthesis (each sees ALL Layer 1 outputs)
    ┌──────┐  ┌──────┐  ┌──────┐
    │Synth │  │Synth │  │Synth │
    │  A   │  │  B   │  │  C   │
    └──┬───┘  └──┬───┘  └──┬───┘
       │         │         │
    Layer 3: Final Strategy
    ┌──────────────────────────┐
    │    Strategic Planner     │
    │ (sees ALL Layer 2 output)│
    └──────────────────────────┘
```

**How It Enhances RedAmon:**
- Layer 1 experts can use different models or prompting strategies
- Layer 2 cross-pollination catches what individual experts miss
- Layer 3 produces a coherent strategy that accounts for all perspectives
- MoA achieved 65.1% on AlpacaEval 2.0 (vs GPT-4o's 57.5%) using only open-source models

**Complexity:** Medium-High — multi-layer architecture, inter-layer communication
**Impact:** High — iterative refinement consistently outperforms single-model approaches

---

### 5.3 Agent Swarms

**What it is:** Decentralized multi-agent systems that self-organize based on the task, inspired by biological swarm intelligence.

**Architecture:**
```python
class AgentSwarm:
    """Decentralized swarm of reconnaissance agents."""

    def __init__(self, n_agents: int = 5):
        self.agents = [SwarmAgent(id=i, specialization=None) for i in range(n_agents)]
        self.message_board = MessageBoard()  # Shared communication channel

    async def run(self, target: str):
        """Agents self-organize around the target."""
        # All agents start with same objective
        for agent in self.agents:
            agent.objective = f"Reconnaissance on {target}"

        # Agents run concurrently, posting findings to shared board
        tasks = [agent.explore(self.message_board) for agent in self.agents]
        await asyncio.gather(*tasks)

    class SwarmAgent:
        async def explore(self, board: MessageBoard):
            """Autonomous exploration with shared communication."""
            while not self.done:
                # Check board for others' findings
                others_findings = board.get_recent()

                # Decide what to do based on what others found
                my_action = await self._decide(others_findings)

                # Execute and post results
                result = await self._execute(my_action)
                board.post(self.id, result)

                # Specialize based on success patterns
                self._adapt_specialization(result)
```

**How It Enhances RedAmon:**
- Emergent specialization — agents that find more vulns in web apps naturally focus on web
- Fault tolerance — if one agent gets blocked, others continue
- Scales to large target scopes (e.g., entire /24 subnet)

**Complexity:** High — decentralized coordination, emergent behavior
**Impact:** Medium — powerful for large-scope recon, less valuable for focused exploitation

---

### 5.4 Cognitive Architectures

**What it is:** Structured processing inspired by ACT-R / SOAR cognitive architectures, with explicit declarative memory, procedural memory, and a production system.

**Architecture:**

```
    ┌─────────────────────────────────────────────────┐
    │                COGNITIVE AGENT                   │
    │                                                  │
    │  ┌──────────────┐    ┌──────────────┐           │
    │  │  DECLARATIVE  │    │  PROCEDURAL  │           │
    │  │   MEMORY      │    │   MEMORY     │           │
    │  │ (facts about  │    │ (IF-THEN     │           │
    │  │  targets,     │    │  rules for   │           │
    │  │  CVEs, tools) │    │  pentesting) │           │
    │  └──────┬───────┘    └──────┬───────┘           │
    │         │                    │                    │
    │  ┌──────▼────────────────────▼───────┐          │
    │  │       PRODUCTION SYSTEM            │          │
    │  │  (matches conditions → actions)    │          │
    │  │                                    │          │
    │  │  IF port_3306_open AND mysql_5.x   │          │
    │  │  THEN test_CVE-2016-6662           │          │
    │  │                                    │          │
    │  │  IF waf_detected AND cloudflare    │          │
    │  │  THEN use_tamper_scripts           │          │
    │  └──────────────┬────────────────────┘          │
    │                 │                                │
    │  ┌──────────────▼────────────────────┐          │
    │  │       GOAL STACK                   │          │
    │  │  1. [compromise_target]            │          │
    │  │  2.   [find_vulnerability]         │          │
    │  │  3.     [scan_web_app]             │          │
    │  └───────────────────────────────────┘          │
    └─────────────────────────────────────────────────┘
```

**Knowledge Compilation:** Over time, frequently-used reasoning patterns become "compiled" fast-path rules:
```python
# Initially (slow deliberative reasoning):
# LLM reasons: "Port 22 is open, running OpenSSH 7.x, let me think about what CVEs affect this version..."

# After 50 similar encounters (compiled rule):
compiled_rules = {
    ("openssh", "7.x"): {
        "action": "test_username_enumeration",
        "module": "auxiliary/scanner/ssh/ssh_enumusers",
        "confidence": 0.85,
        "note": "OpenSSH 7.x often vulnerable to CVE-2018-15473 user enumeration"
    }
}
```

**Complexity:** High — full cognitive architecture
**Impact:** Medium-High — provides principled organization, most valuable for complex long-running engagements

---

## 6. Supplementary Techniques

---

### 6.1 Chain-of-Abstraction

**What it is:** The LLM reasons with abstract placeholders (e.g., `[LOOKUP: CVE for Apache 2.4.49]`) that are later resolved by tool calls, decoupling reasoning strategy from domain knowledge.

```python
# Agent reasons abstractly:
thought = """
The target runs [LOOKUP: service on port 8080].
Given [LOOKUP: known CVEs for {service}],
the best exploit is [SEARCH: exploit module for top CVE].
"""

# Placeholders resolved in parallel:
resolved = await resolve_placeholders(thought)
```

**Impact:** High — methodology stays stable while domain knowledge is always fresh
**Complexity:** Medium

---

### 6.2 Skeleton-of-Thought

**What it is:** Generate an outline first, then fill in details in parallel.

**Use in RedAmon:** For report generation and engagement planning (not sequential exploitation).

```python
# Skeleton: "1. Port scan results, 2. Vulnerability findings, 3. Exploitation results, 4. Recommendations"
# Each section filled by separate LLM calls in parallel
```

**Impact:** Low-Medium (speed optimization, not reasoning quality)
**Complexity:** Low

---

### 6.3 Progressive Deepening

**What it is:** Start with shallow analysis, progressively deepen only where needed.

```python
# Depth 1: Quick port scan → known vulnerable? → exploit immediately
# Depth 2: Full service enum → version detection → CVE search
# Depth 3: Deep analysis → fuzzing → logic flaw hunting → custom exploit development
```

**How It Enhances RedAmon:** Avoids overthinking easy targets while being thorough on hard ones.

**Impact:** Medium-High
**Complexity:** Low-Medium

---

### 6.4 Speculative Execution

**What it is:** While waiting for slow tools (nmap full scan), speculatively start actions assuming likely outcomes.

```python
# While nmap runs full scan (3-5 min):
speculative_tasks = [
    run_web_fingerprint("http://target:80"),   # Bet that 80 is open
    run_web_fingerprint("https://target:443"),  # Bet that 443 is open
    run_ssh_banner("target:22"),               # Bet that 22 is open
]
# When nmap completes, validate or discard speculative results
```

**Impact:** Medium (speed, not reasoning)
**Complexity:** Medium

---

### 6.5 Reward Modeling / Self-Reward

**What it is:** Using the LLM's own confidence as a reward signal to guide reasoning.

```python
async def self_reward(self, decision: LLMDecision) -> float:
    """Use LLM confidence in outcome as reward."""
    prompt = f"""If I execute: {decision.tool_name}({decision.tool_args})
    How confident am I that this will produce useful results?
    Rate 0.0 to 1.0."""
    response = await self.llm.ainvoke([HumanMessage(content=prompt)])
    return float(response.content.strip())
```

**Impact:** High (guides exploration)
**Complexity:** Medium (training-free self-reward) to High (trained PRM)

---

### 6.6 Constitutional AI / Self-Critique

**What it is:** Self-evaluate against pentesting principles before every action.

```python
PENTESTING_CONSTITUTION = [
    "Always verify scope before testing any target",
    "Never run destructive exploits without explicit authorization",
    "Prioritize stealth over speed in red team engagements",
    "Verify findings with at least two independent methods before reporting",
    "Do not make assumptions about DBMS type without evidence",
    "Check for WAF/IDS before attempting exploitation",
]
```

**Impact:** Medium (safety and correctness)
**Complexity:** Low-Medium

---

### 6.7 Tool-Augmented Reasoning

**What it is:** Allow tool calls WITHIN the thinking phase (not just at the Action step).

```python
# Current: Think → Action → Observation → Think
# Enhanced: Think[+tool] → Action → Observation → Think[+tool]

# Example: During thinking, the agent calls a quick graph query:
# "Let me check what we know about this port... [INLINE_TOOL: query_graph('port 8443 services')]
#  ...OK, it's running Tomcat. So I should look for CVE-2020-1938 (GhostCat)."
```

**Impact:** High (tighter reasoning-information loop)
**Complexity:** Medium

---

### 6.8 Beam Search Decoding for Reasoning

**What it is:** Maintain multiple candidate action plans simultaneously, scoring and pruning at each step.

```python
async def beam_search_action(self, state: AgentState, beam_width: int = 3):
    """Maintain top-K action candidates."""
    beams = await self._generate_candidates(state, n=beam_width * 2)
    scored = [(await self._score(b, state), b) for b in beams]
    top_beams = sorted(scored, reverse=True, key=lambda x: x[0])[:beam_width]
    return top_beams[0][1]  # Execute highest-scored
```

**Impact:** Medium (lighter-weight alternative to full ToT)
**Complexity:** Medium

---

## 7. Implementation Roadmap

### Phase 1: Foundation (Week 1-2)
> Quick wins that lay groundwork for later enhancements.

| Task | Technique | Files to Modify |
|------|-----------|-----------------|
| Add Think Deeply node | 2.1 Inner Monologue | `orchestrator.py` (graph builder), `state.py` (new field) |
| Add CoVe for findings | 2.2 Chain-of-Verification | `orchestrator.py` (think node), new `verification.py` |
| System 1/2 routing | 2.4 Dual Processing | `orchestrator.py` (classify + route) |
| Metacognitive monitor | 3.5 Meta-Cognition | New `metacognition.py`, integrate in think node |

### Phase 2: Strategic Intelligence (Week 3-4)
> Hierarchical planning and learning from experience.

| Task | Technique | Files to Modify |
|------|-----------|-----------------|
| Hierarchical planner | 3.1 Plan-and-Act | New `planner.py`, replace todo system |
| Reflexion memory | 3.2 Reflexion | New `reflection.py`, integrate in think node |
| Dynamic context assembly | 3.3 Context Engineering | Refactor `prompts/base.py` into `context_assembler.py` |
| Critic agent | 3.4 Critic/Verifier | New `critic.py`, integrate before execute_tool |

### Phase 3: Multi-Agent (Week 5-6)
> Parallel execution and knowledge retrieval.

| Task | Technique | Files to Modify |
|------|-----------|-----------------|
| Parallel recon | 3.8 Parallel Agents | New `parallel_recon.py`, modify orchestrator |
| RAG knowledge base | 3.7 RAG | New `knowledge_base.py`, upgrade search |
| Episodic memory | 3.6 Experience Replay | New `episodic_memory.py`, Neo4j schema |
| Tool-use planning | 2.3 Tool Planning | Modify `state.py` (new action type), orchestrator |

### Phase 4: Advanced Reasoning (Week 7-8+)
> Frontier techniques for complex scenarios.

| Task | Technique | Files to Modify |
|------|-----------|-----------------|
| Tree-of-Thought | 4.1 ToT | New `tot.py`, integrate for attack vector selection |
| Test-Time Compute | 4.4 TTC | New `ttc.py`, integrate difficulty-based allocation |
| World model | 4.5 Mental Simulation | New `world_model.py`, update from observations |
| Multi-agent debate | 5.1 Debate | New `debate.py`, for strategic decisions |

---

## 8. Summary Matrix

| # | Technique | Complexity | Impact | Best For | Priority |
|---|-----------|:----------:|:------:|----------|:--------:|
| 2.1 | Think Node / Inner Monologue | Low | Med-High | All reasoning steps | **P0** |
| 2.2 | Chain-of-Verification | Low-Med | High | False positive reduction | **P0** |
| 2.3 | Tool-Use Planning | Low-Med | Med-High | Tool sequencing/parallelism | **DONE** |
| 2.4 | System 1 / System 2 | Medium | High | Efficiency optimization | **P0** |
| 2.5 | Self-Consistency Voting | Low | Medium | Critical decisions | P1 |
| 3.1 | Hierarchical Planning | Medium | High | Long engagements | **P1** |
| 3.2 | Reflexion | Medium | High | Learning from failures | **P1** |
| 3.3 | Dynamic Prompt Assembly | Medium | High | Context optimization | **P1** |
| 3.4 | Critic / Verifier Agents | Medium | High | Finding verification | **P1** |
| 3.5 | Meta-Cognition | Medium | High | Strategy switching | **P1** |
| 3.6 | Experience Replay | Medium | High | Recurring patterns | P2 |
| 3.7 | RAG-Enhanced Reasoning | Medium | High | CVE/exploit knowledge | P2 |
| 3.8 | Parallel Agents | Medium | High | Reconnaissance speed | P2 |
| 4.1 | Tree-of-Thought | High | High | Attack vector selection | P3 |
| 4.2 | Graph-of-Thought | High | High | Correlating findings | P3 |
| 4.3 | MCTS | High | High | Exploit chain planning | P3 |
| 4.4 | Test-Time Compute | High | High | Hard decisions | P3 |
| 4.5 | World Models | High | High | Stealth operations | P3 |
| 5.1 | Multi-Agent Debate | Medium | Medium | Risk assessment | P3 |
| 5.2 | Mixture of Agents | Med-High | High | Comprehensive analysis | P4 |
| 5.3 | Agent Swarms | High | Medium | Large-scope recon | P4 |
| 5.4 | Cognitive Architectures | High | Med-High | Complex engagements | P4 |
| 6.1 | Chain-of-Abstraction | Medium | High | Methodology generalization | P2 |
| 6.2 | Skeleton-of-Thought | Low | Low-Med | Report generation | P3 |
| 6.3 | Progressive Deepening | Low-Med | Med-High | Variable targets | P1 |
| 6.4 | Speculative Execution | Medium | Medium | Reducing wait time | P2 |
| 6.5 | Reward Modeling | Med-High | High | Action scoring | P3 |
| 6.6 | Constitutional AI | Low-Med | Medium | Scope/safety | P1 |
| 6.7 | Tool-Augmented Reasoning | Medium | High | Inline data gathering | P2 |
| 6.8 | Beam Search Reasoning | Medium | Medium | Action selection | P3 |

---

## 9. References

### Core Papers
- Yao et al. (2022) — *ReAct: Synergizing Reasoning and Acting in Language Models* — https://arxiv.org/abs/2210.03629
- Yao et al. (2023) — *Tree of Thoughts: Deliberate Problem Solving with LLMs* — https://arxiv.org/abs/2305.10601
- Besta et al. (2023) — *Graph of Thoughts: Solving Elaborate Problems with LLMs* — https://arxiv.org/abs/2308.09687
- Snell et al. (2024) — *Scaling LLM Test-Time Compute Optimally* — https://arxiv.org/abs/2408.03314
- Shinn et al. (2023) — *Reflexion: Language Agents with Verbal Reinforcement Learning* — https://arxiv.org/abs/2303.11366
- Dhuliawala et al. (2023) — *Chain-of-Verification Reduces Hallucination* — https://arxiv.org/abs/2309.11495
- Wang et al. (2022) — *Self-Consistency Improves Chain of Thought Reasoning in LLMs* — https://arxiv.org/abs/2203.11171
- Bai et al. (2022) — *Constitutional AI: Harmlessness from AI Feedback* — https://arxiv.org/abs/2212.08073

### Multi-Agent & Architecture
- Together AI (2024) — *Mixture-of-Agents Enhances LLM Capabilities* — https://arxiv.org/abs/2406.04692
- Du et al. (2023) — *Improving Factuality and Reasoning via Multi-Agent Debate* — https://arxiv.org/abs/2305.14325
- Sun et al. (2025) — *AgentNet: Decentralized Evolutionary Coordination* — https://arxiv.org/abs/2504.00587
- Zhu et al. (2025) — *Plan-and-Act: Improving Planning of Agents for Long-Horizon Tasks* — https://arxiv.org/abs/2503.09572

### Reasoning Enhancements
- Ning et al. (2023) — *Skeleton-of-Thought: Parallel Decoding* — https://arxiv.org/abs/2307.15337
- Gao et al. (2024) — *Chain-of-Abstraction Reasoning* — https://arxiv.org/abs/2401.17464
- Fan et al. (2025) — *From System 1 to System 2: A Survey of Reasoning LLMs* — https://arxiv.org/abs/2502.17419
- Adaptive Graph of Thoughts (2025) — https://arxiv.org/pdf/2502.05078
- SWE-Search: MCTS for Software Engineering Agents — https://openreview.net/forum?id=G7sIFXugTX

### Tool & Memory
- Singh et al. (2025) — *Agentic Retrieval-Augmented Generation: A Survey* — https://arxiv.org/abs/2501.09136
- Anokhin et al. (2025) — *AriGraph: Learning Knowledge Graph World Models with Episodic Memory* — https://arxiv.org/abs/2407.04363
- Agentic Context Engineering (ACE) — https://arxiv.org/abs/2510.04618

### Verification & Critique
- Luo et al. (2025) — *Critique-Guided Improvement (SWEET-RL)* — https://arxiv.org/html/2503.16024v2
- CRew: Confidence as Reward — https://arxiv.org/abs/2510.13501

---

> **Next Step:** Pick a technique from Tier 1 and start implementing. The recommended first implementation is the **Think Deeply Node** (2.1) — it's the lowest complexity, highest impact starting point that also lays the foundation for all other techniques.
