"""LATS (Language Agent Tree Search) — bounded, value-guided search over
executed exploit probes.

This module is the self-contained LATS engine. See internal/LATS_integration.md
for the full design. The orchestrator's only contact with LATS is:
  1. state.py declaring the LATS state fields (LangGraph strips undeclared keys).
  2. a single `lats_hook(...)` call inside think_node (added in Step 2).

Everything here is stateless: all per-session search state lives in the
`_exploit_tree` dict on AgentState, so concurrent sessions never share LATS
state. The tree rides inside AgentState and the Postgres checkpointer persists
it for free.

STEP 1 (this file's first cut) ships the PURE engine only:
  value function, UCT, select, backprop, expand (structured probe generation),
  tree bookkeeping, activation gate, and the completion/archive helpers.
The think_node hook, streaming emission, and decision override arrive in later
steps and build on these primitives.
"""

from __future__ import annotations

import json
import logging
import math
import re
from typing import Any, List, Optional

from project_settings import get_setting, TOOL_MUTEX_GROUPS, DANGEROUS_TOOLS
from orchestrator_helpers.error_class import is_diagnostic_failure
from state import ExploitTree, ExploitTreeNode

logger = logging.getLogger(__name__)


# =============================================================================
# Small accessors — value helpers must tolerate both a pydantic
# OutputAnalysisInline and a plain dict (tests feed dicts).
# =============================================================================

def _attr(obj: Any, key: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


# =============================================================================
# VALUE FUNCTION (§6) — inverts compute_productivity_score's "badness" into
# "goodness" (higher = closer to a foothold), enriched with error_class.
# All inputs are already computed upstream; lats_value adds no I/O.
# =============================================================================

def _exploit_succeeded(step: dict, analysis: Any, credited: bool = True) -> bool:
    """True when the just-executed probe reached a foothold.

    Attribution order (§6, §20.2): the step's own flag, then a per_step entry
    keyed by step_index (authoritative localization for a wave), then the
    aggregate analysis flag — but the aggregate is only credited to the ONE
    designated child (`credited=True`). Without this, a wave-level
    exploit_succeeded=True would mark EVERY sibling terminal (Bug: over-credit)."""
    if step and step.get("exploit_succeeded"):
        return True
    if step is not None:
        idx = step.get("_step_index")
        for ps in (_attr(analysis, "per_step", []) or []):
            if _attr(ps, "step_index", -1) == idx and _attr(ps, "exploit_succeeded", False):
                return True
    if credited:
        return bool(_attr(analysis, "exploit_succeeded", False))
    return False


def _verdict_for(step: dict, analysis: Any) -> str:
    """The ProductivityVerdict.verdict for this step. A per_step entry (keyed
    by step_index) wins; otherwise the aggregate productivity verdict."""
    if step is not None:
        idx = step.get("_step_index")
        per_step = _attr(analysis, "per_step", []) or []
        if idx is not None:
            for ps in per_step:
                if _attr(ps, "step_index", -1) == idx:
                    v = _attr(ps, "verdict", "")
                    if v:
                        return v
        # A single-step turn may stamp the verdict directly on the step.
        if step.get("verdict"):
            return step["verdict"]
    prod = _attr(analysis, "productivity", None)
    return _attr(prod, "verdict", "") or ""


def _new_finding_confidence(step: dict, analysis: Any, credited: bool = True) -> int:
    """Confidence (0-100) of any ChainFinding attributed to this step.

    A per_step entry keyed by step_index wins (authoritative per-child); the
    aggregate finding is credited only to the ONE designated child
    (`credited=True`), else 0 — otherwise every wave sibling inherits the
    aggregate confidence and its value is inflated (Bug: over-credit)."""
    if step is not None:
        idx = step.get("_step_index")
        per_step = _attr(analysis, "per_step", []) or []
        if idx is not None:
            for ps in per_step:
                if _attr(ps, "step_index", -1) == idx and _attr(ps, "finding", ""):
                    return int(_attr(ps, "confidence", 0) or 0)
    if not credited:
        return 0
    findings = _attr(analysis, "chain_findings", []) or []
    best = 0
    for f in findings:
        c = int(_attr(f, "confidence", 0) or 0)
        if c > best:
            best = c
    return best


def _lats_value_web(step: dict, analysis: Any, credited: bool = True) -> float:
    """Web-exploitation value: error_class carries the signal (§6)."""
    ec = step.get("error_class", "") if step else ""
    verdict = _verdict_for(step, analysis)

    # (0) Diagnostic failure: the probe never reached the app (bad quoting, DNS,
    #     tool crash, parse-time 5xx). NEUTRAL, so UCT retries rather than
    #     abandoning a possibly-live vector. Small floor: not pruned, not deep.
    if is_diagnostic_failure(ec):
        return 0.15

    v = 0.0
    # (a) New durable evidence.
    v += 0.5 * (_new_finding_confidence(step, analysis, credited) / 100.0)
    # (b) Response informativeness.
    if verdict in ("new_info", "diagnostic_progress"):
        v += 0.3
    if ec == "application_5xx_normal":       # DB / business-logic path reached
        v += 0.2
    if verdict == "confirmation":
        v += 0.1
    # (c) Penalties for real dead-ends (probe reached the app, was rejected).
    if verdict in ("blocked", "duplicate", "no_progress"):
        v -= 0.3
    if ec == "application_4xx":               # 403 / WAF / semantic rejection
        v -= 0.2
    return max(0.0, v)


def _new_finding(step: dict, analysis: Any) -> bool:
    return _new_finding_confidence(step, analysis) > 0


def _privilege_increased(before: dict, after: dict) -> bool:
    return _delta_count(before, after, "privilege_escalation") > 0


def _new_session(before: dict, after: dict) -> bool:
    return _len_of(after, "sessions") > _len_of(before, "sessions")


def _new_credentials(before: dict, after: dict) -> bool:
    return _len_of(after, "credentials") > _len_of(before, "credentials")


def _new_host_reached(before: dict, after: dict) -> bool:
    return _len_of(after, "hosts") > _len_of(before, "hosts")


def _len_of(snapshot: Optional[dict], key: str) -> int:
    if not snapshot:
        return 0
    val = snapshot.get(key)
    try:
        return len(val) if val is not None else 0
    except TypeError:
        return 0


def _delta_count(before: Optional[dict], after: Optional[dict], finding_type: str) -> int:
    def _count(snap):
        if not snap:
            return 0
        return int(snap.get(f"finding_{finding_type}", 0) or 0)
    return _count(after) - _count(before)


def _lats_value_post_expl(step: dict, analysis: Any, before: dict, after: dict,
                          credited: bool = True) -> float:
    """Post-exploitation value from engagement-state deltas (§6.1). In this
    phase error_class 4xx/5xx branches are inert, so score from privilege /
    session / credential / host / finding growth instead."""
    if is_diagnostic_failure(step.get("error_class", "") if step else ""):
        return 0.15                                  # command never ran; retry
    v = 0.0
    if _privilege_increased(before, after):
        v += 0.6
    if _new_session(before, after):
        v += 0.5
    if _new_credentials(before, after):
        v += 0.4
    if _new_host_reached(before, after):
        v += 0.4
    if _new_finding_confidence(step, analysis, credited) > 0:
        v += 0.3
    if _verdict_for(step, analysis) in ("no_progress", "duplicate"):
        v -= 0.3
    return max(0.0, min(1.0, v))


def lats_value(step: dict, analysis: Any, phase: Optional[str] = None,
               before: Optional[dict] = None, after: Optional[dict] = None,
               credited: bool = True) -> float:
    """Value of a just-executed probe. Terminal success is the strong reward;
    otherwise dispatch on phase (§6.1). `credited` gates whether the aggregate
    wave-level exploit/finding signal is attributed to THIS child (§20.2)."""
    if _exploit_succeeded(step, analysis, credited):
        return 1.0
    if phase == "post_exploitation":
        return _lats_value_post_expl(step, analysis, before or {}, after or {}, credited)
    return _lats_value_web(step, analysis, credited)


# =============================================================================
# UCT / SELECT / BACKPROP (§6) — textbook and pure.
# =============================================================================

def uct(node: ExploitTreeNode, parent_visits: int, c: float) -> float:
    if node.visits == 0:
        return float("inf")   # always try an unvisited frontier node once
    return node.value + c * math.sqrt(math.log(max(parent_visits, 1)) / node.visits)


def _live_children(tree: ExploitTree, node: ExploitTreeNode) -> List[ExploitTreeNode]:
    return [tree.nodes[cid] for cid in node.children
            if tree.nodes[cid].status in ("proposed", "evaluated", "executing")]


def _has_proposed_children(tree: ExploitTree, node: ExploitTreeNode) -> bool:
    return any(tree.nodes[cid].status == "proposed" for cid in node.children)


def lats_select(tree: ExploitTree, c: float) -> str:
    """Descend from root by UCT to a node the hook can act on this turn: one
    that either has unexecuted (proposed) children to fire, or can be expanded,
    or is a dead frontier. Stops at the first such node.

    NOTE: this refines the doc's textbook pseudocode (§6) to stay consistent
    with the hook flow (§5.3), which needs SELECT to return the PARENT of the
    next wave (a node with proposed children), not descend past it.
    """
    cur = tree.nodes[tree.root_id]
    while True:
        # A node with pending probes is where the next wave fires.
        if _has_proposed_children(tree, cur):
            return cur.id
        # An evaluated leaf with room to grow is expanded next.
        if _can_expand(cur):
            return cur.id
        # Otherwise descend into the best evaluated child by UCT.
        eval_children = [tree.nodes[cid] for cid in cur.children
                         if tree.nodes[cid].status == "evaluated"]
        if not eval_children:
            return cur.id   # dead frontier: nothing to do under this node
        cur = max(eval_children, key=lambda n: uct(n, cur.visits, c))


def lats_backprop(tree: ExploitTree, node_id: str, value: float) -> None:
    """Push value up the ancestor chain (running max), incrementing visits."""
    nid: Optional[str] = node_id
    while nid is not None:
        n = tree.nodes[nid]
        n.visits += 1
        n.value = max(n.value, value)   # running max keeps a branch hot if any descendant is promising
        nid = n.parent_id


# =============================================================================
# EXPANDABILITY / FRONTIER / BUDGET (§8)
# =============================================================================

def _can_expand(node: ExploitTreeNode) -> bool:
    return (node.status == "evaluated"
            and node.depth < get_setting("LATS_MAX_DEPTH", 6)
            and not node.children)


def _executing_children(tree: ExploitTree) -> List[ExploitTreeNode]:
    return [n for n in tree.nodes.values() if n.status == "executing"]


def _proposed_children(tree: ExploitTree, node: ExploitTreeNode) -> List[ExploitTreeNode]:
    return [tree.nodes[cid] for cid in node.children
            if tree.nodes[cid].status == "proposed"]


def _open_leaves(tree: ExploitTree) -> List[ExploitTreeNode]:
    """Live (proposed/evaluated) nodes with no live children — the frontier."""
    leaves = []
    for n in tree.nodes.values():
        if n.status not in ("proposed", "evaluated"):
            continue
        if not _live_children(tree, n):
            leaves.append(n)
    return leaves


def _single_open_line(tree: ExploitTree) -> bool:
    """True when the search has degenerated to one credible line with no
    remaining branching decision: nothing queued (no proposed/executing probes)
    and exactly one live leaf that CANNOT expand further (depth-capped or
    already fully expanded). LATS then hands that obvious line back to legacy
    ReAct rather than keep the tree machinery running (§5.4 EXIT collapse).

    A lone leaf that can still expand is NOT a collapse — LATS deepens it (that
    is the §10 hot-branch behavior), so we only collapse when there is genuinely
    nothing left to branch on.
    """
    if tree.rollouts < 1:
        return False
    for n in tree.nodes.values():
        if n.status in ("proposed", "executing"):
            return False
    leaves = _open_leaves(tree)
    return len(leaves) == 1 and not _can_expand(leaves[0])


def _tree_exhausted(tree: ExploitTree) -> bool:
    """No proposed/executing probes remain and nothing is expandable."""
    for n in tree.nodes.values():
        if n.status in ("proposed", "executing"):
            return False
    return not any(_can_expand(n) for n in tree.nodes.values())


def _budget_hit(tree: ExploitTree) -> bool:
    return (tree.rollouts >= get_setting("LATS_MAX_ROLLOUTS", 24)
            or len(tree.nodes) >= get_setting("LATS_MAX_TREE_NODES", 60))


# =============================================================================
# TREE BOOKKEEPING (§4)
# =============================================================================

def _new_tree(state: dict, root_children: List[dict]) -> ExploitTree:
    """Seed a fresh tree: a synthetic root plus its candidate-probe children."""
    root = ExploitTreeNode(depth=0, status="evaluated", probe_rationale="root")
    tree = ExploitTree(
        root_id=root.id,
        nodes={root.id: root},
        active_node_id=root.id,
        objective=_objective_of(state),
        attack_path_type=state.get("attack_path_type", "") or "",
        primary_target=(state.get("target_info", {}) or {}).get("primary_target", "") or "",
    )
    for cand in root_children:
        _add_child(tree, root, cand)
    return tree


def _objective_of(state: dict) -> str:
    objs = state.get("conversation_objectives") or []
    idx = state.get("current_objective_index", 0)
    if 0 <= idx < len(objs):
        o = objs[idx]
        return (o.get("objective") or o.get("description") or "") if isinstance(o, dict) else str(o)
    return state.get("original_objective", "") or ""


def _add_child(tree: ExploitTree, parent: ExploitTreeNode, cand: dict,
               prior: str = "normal") -> ExploitTreeNode:
    node = ExploitTreeNode(
        parent_id=parent.id,
        depth=parent.depth + 1,
        tool_name=cand.get("tool_name"),
        tool_args=cand.get("tool_args") or {},
        probe_rationale=cand.get("rationale", "") or cand.get("probe_rationale", ""),
        status="proposed",
    )
    # A boosted prior (operator guidance graft, §21.1) is modeled as a seed
    # visit-0 value so UCT still tries it first but backprop can correct it.
    if prior == "high":
        node.local_value = 0.5
    tree.nodes[node.id] = node
    parent.children.append(node.id)
    return node


def _highest_prior(kids: List[ExploitTreeNode]) -> ExploitTreeNode:
    return max(kids, key=lambda n: n.local_value)


def _mutex_safe_subset(kids: List[ExploitTreeNode]) -> List[ExploitTreeNode]:
    """Pick a wave that violates no TOOL_MUTEX_GROUP: at most one tool per
    mutex group. Deferred kids stay `proposed` for a later turn. Dangerous
    tools are NOT excluded — the mark is confirmation-only (§20.3).
    """
    group_of = {}
    for group, tools in TOOL_MUTEX_GROUPS.items():
        for t in tools:
            group_of[t] = group
    wave: List[ExploitTreeNode] = []
    claimed: set = set()
    for k in kids:
        g = group_of.get(k.tool_name)
        if g is not None:
            if g in claimed:
                continue          # defer: another kid already claimed this group
            claimed.add(g)
        wave.append(k)
    return wave


def _wave(wave: List[ExploitTreeNode]) -> dict:
    """Build a ToolPlan-shaped dict from a set of child edges. Dangerous steps
    are allowed; the existing confirmation gate handles the prompt (§20.3)."""
    return {
        "steps": [
            {"tool_name": k.tool_name, "tool_args": k.tool_args or {},
             "reasoning": k.probe_rationale, "_lats_node_id": k.id}
            for k in wave
        ]
    }


def _is_dangerous(node: ExploitTreeNode) -> bool:
    return node.tool_name in DANGEROUS_TOOLS


# =============================================================================
# OBSERVATION SUMMARY / REFLECTION — DETERMINISTIC, no LLM (§20.10).
# =============================================================================

_STATUS_RE = re.compile(r"\b(HTTP/\d\.\d\s+)?([1-5]\d{2})\b")
_TOKENISH_RE = re.compile(r"(token|secret|key|flag|error|exception|traceback|denied|unauthorized|admin)", re.I)


def _summarize(tool_output: Optional[str], cap: int = 200) -> str:
    """Compress tool output to ~`cap` chars, preserving the highest-signal
    tokens (HTTP status, error/leak markers). Deterministic; never an LLM."""
    if not tool_output:
        return ""
    text = str(tool_output).strip()
    # Prefer a line carrying an HTTP status or a signal keyword.
    for line in text.splitlines():
        if _STATUS_RE.search(line) or _TOKENISH_RE.search(line):
            line = line.strip()
            return line[:cap]
    single = " ".join(text.split())
    return single[:cap]


def _reflect(step: dict, analysis: Any) -> str:
    """One-line lesson for a pruned/failed node. Deterministic."""
    ec = step.get("error_class", "") if step else ""
    verdict = _verdict_for(step, analysis)
    if ec == "application_4xx":
        return "server rejected the probe (auth / WAF / method)"
    if verdict == "blocked":
        return "blocked; vector rejected at the app layer"
    if verdict == "duplicate":
        return "duplicate of a prior probe; no new signal"
    if verdict == "no_progress":
        return "no progress; branch cold"
    summ = _summarize(step.get("tool_output") if step else "", cap=80)
    return f"low value; {summ}" if summ else "low value; branch pruned"


# =============================================================================
# ACTIVATION GATE (§5.1) — cheap pre-gate; the ENTER decision also requires the
# lats_expand assessment to yield >= 2 credible probes (enforced in the hook).
# =============================================================================

def _surface_exists(state: dict) -> bool:
    if state.get("chain_findings_memory"):
        return True
    ti = state.get("target_info", {}) or {}
    return bool(ti.get("vulnerabilities") or ti.get("services") or ti.get("technologies"))


def _already_exploited(state: dict) -> bool:
    """A foothold is already in hand for the current objective."""
    for f in (state.get("chain_findings_memory") or []):
        ft = (f.get("finding_type") if isinstance(f, dict) else "") or ""
        if ft in ("exploit_success", "access_gained", "privilege_escalation",
                  "remote_code_execution", "session_hijacked"):
            return True
    return False


def lats_active(state: dict) -> bool:
    """Cheap pre-gate for whether to ATTEMPT activation this turn (§5.1). The
    actual ENTER also requires the lats_expand assessment to yield >= 2 probes.
    Keys on Deep Think's FIRING flag, NOT its output (§20.16)."""
    if not get_setting("LATS_ENABLED", False):
        return False
    allowed = get_setting("LATS_ALLOWED_PHASES", ["exploitation"])
    if state.get("current_phase") not in allowed:
        return False
    if not _surface_exists(state):
        return False
    if _already_exploited(state):
        return False
    return bool(state.get("deep_think_ran_this_turn"))


def _lats_should_reset(state: dict, tree: ExploitTree) -> bool:
    """Archive-and-restart triggers for a live tree (§20.6). ANY of: task done;
    phase left the allowed set; objective advanced; skill switched; primary
    target changed; objective already exploited."""
    if state.get("task_complete"):
        return True
    if state.get("current_phase") not in get_setting("LATS_ALLOWED_PHASES", ["exploitation"]):
        return True
    if _already_exploited(state):
        return True
    # Objective advanced: the tree stamped which objective it serves.
    if tree.objective and tree.objective != _objective_of(state):
        return True
    # Skill switched (switch_skill rebinds attack_path_type without necessarily
    # changing the objective text) — the old tree's probes are for the wrong skill.
    if tree.attack_path_type and tree.attack_path_type != (state.get("attack_path_type", "") or ""):
        return True
    # Primary target changed.
    cur_target = (state.get("target_info", {}) or {}).get("primary_target", "") or ""
    if tree.primary_target and cur_target and tree.primary_target != cur_target:
        return True
    return False


# =============================================================================
# EXPAND (§20.9) — LATS's OWN structured probe generator on the single agent
# model. NEVER reads deep_think_result (§20.16). node=None -> root assessment.
# =============================================================================

def _phase_allowed_tools(state: dict) -> set:
    tpm = get_setting("TOOL_PHASE_MAP", {}) or {}
    phase = state.get("current_phase", "exploitation")
    return {name for name, phases in tpm.items() if phase in phases}


def _parse_expand_response(text: str, allowed_tools: set, branching: int) -> List[dict]:
    """Pure parser + validator for a structured expand response. Returns up to
    `branching` probes, each {tool_name, tool_args, rationale}, dropping any
    probe whose tool_name is missing or not phase-allowed (§20.9)."""
    if not text:
        return []
    payload = _extract_json(text)
    if payload is None:
        return []
    raw = payload.get("probes") if isinstance(payload, dict) else payload
    if not isinstance(raw, list):
        return []
    probes: List[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        tn = item.get("tool_name")
        if not tn or (allowed_tools and tn not in allowed_tools):
            continue                      # off-registry / not phase-allowed -> drop
        args = item.get("tool_args")
        if args is not None and not isinstance(args, dict):
            continue
        probes.append({
            "tool_name": tn,
            "tool_args": args or {},
            "rationale": str(item.get("rationale", "") or "")[:400],
        })
        if len(probes) >= branching:
            break
    return probes


def _extract_json(text: str) -> Optional[Any]:
    """Best-effort JSON extraction from an LLM string (handles fenced blocks)."""
    text = text.strip()
    if "```" in text:
        m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
        if m:
            text = m.group(1).strip()
    try:
        return json.loads(text)
    except Exception:
        # Fall back to the first {...} or [...] span.
        for opener, closer in (("{", "}"), ("[", "]")):
            i, j = text.find(opener), text.rfind(closer)
            if 0 <= i < j:
                try:
                    return json.loads(text[i:j + 1])
                except Exception:
                    continue
    return None


def _expand_prompt_messages(state: dict, node: Optional[ExploitTreeNode],
                            allowed_tools: set, branching: int) -> list:
    """Build the messages for a structured expand call. Kept small and
    deterministic so the only variable is the model's response."""
    objective = _objective_of(state)
    phase = state.get("current_phase", "exploitation")
    tool_list = ", ".join(sorted(allowed_tools)) if allowed_tools else "(any)"
    if node is None or node.tool_name is None:
        context = f"Assess the current situation and propose the {branching} most credible NEXT exploit probes."
    else:
        context = (
            f"You are extending this branch:\n"
            f"  probe: {node.tool_name} {json.dumps(node.tool_args or {})}\n"
            f"  rationale: {node.probe_rationale}\n"
            f"  observation: {node.observation_summary}\n"
            f"Propose the {branching} most credible FOLLOW-UP probes that build on it."
        )
    system = (
        "You are the expansion step of a value-guided exploit-path search. "
        "Return ONLY strict JSON of the form "
        '{\"probes\": [{\"tool_name\": <one of the allowed tools>, '
        '\"tool_args\": {..}, \"rationale\": \"why this probe advances the exploit\"}]}. '
        f"Each tool_name MUST be one of: {tool_list}. "
        f"Return at most {branching} probes, ordered most-promising first. "
        "Each must be a concrete, executable probe (never a plan or a question)."
    )
    user = (
        f"Objective: {objective}\n"
        f"Phase: {phase}\n\n"
        f"{context}"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


async def lats_expand(llm: Any, state: dict, node: Optional[ExploitTreeNode]) -> List[dict]:
    """Generate up to LATS_BRANCHING candidate probes via ONE structured call on
    the single agent model. node=None -> root/situation assessment (ENTER);
    a real node -> extend that branch. Returns validated, phase-valid probes.
    Never touches deep_think_result (§20.16)."""
    from orchestrator_helpers.llm_retry import retry_llm_call

    branching = int(get_setting("LATS_BRANCHING", 3))
    allowed = _phase_allowed_tools(state)
    messages = _expand_prompt_messages(state, node, allowed, branching)
    try:
        resp = await retry_llm_call(llm, messages, label="lats_expand")
    except Exception as exc:
        logger.warning("[lats_expand] LLM call failed: %s", exc)
        return []
    content = getattr(resp, "content", resp)
    if isinstance(content, list):     # some providers return content blocks
        content = " ".join(str(b.get("text", b)) if isinstance(b, dict) else str(b)
                           for b in content)
    return _parse_expand_response(str(content or ""), allowed, branching)


# =============================================================================
# COMPLETION / ARCHIVE (§5.4)
# =============================================================================

def _best_terminal(tree: ExploitTree) -> Optional[str]:
    terminals = [n for n in tree.nodes.values() if n.status == "terminal"]
    if not terminals:
        return None
    return max(terminals, key=lambda n: (n.value, n.depth)).id


def best_trajectory(tree: ExploitTree) -> List[str]:
    """Root-to-hot-leaf id path: follow best terminal if any, else highest-value
    live leaf."""
    target = tree.best_terminal_id or _best_terminal(tree)
    if target is None:
        leaves = _open_leaves(tree)
        if not leaves:
            return [tree.root_id]
        target = max(leaves, key=lambda n: n.value).id
    path = []
    nid: Optional[str] = target
    while nid is not None:
        path.append(nid)
        nid = tree.nodes[nid].parent_id
    return list(reversed(path))


def _archive_tree(state: dict, tree: ExploitTree, reason: str) -> None:
    """Drop the live tree (kept for the report via findings/graph) and clear
    _exploit_tree so a fresh search can start via lats_active next turn."""
    logger.info("[lats] archiving tree %s (%s): rollouts=%d nodes=%d",
                tree.root_id, reason, tree.rollouts, len(tree.nodes))
    state["_exploit_tree"] = None


def _complete(decision: Any, tree: ExploitTree, reason: str) -> Any:
    """Return a decision forced to action=complete with the best trajectory.
    Duck-typed on `.model_copy` so tests can pass a lightweight stand-in."""
    traj = best_trajectory(tree)
    thought = f"[LATS] {reason}: {' -> '.join(traj)}"
    completion_reason = f"LATS {reason}"
    if hasattr(decision, "model_copy"):
        return decision.model_copy(update={"action": "complete", "thought": thought,
                                           "completion_reason": completion_reason})
    # dict fallback (tests)
    if isinstance(decision, dict):
        d = dict(decision)
        d["action"] = "complete"
        d["thought"] = thought
        d["completion_reason"] = completion_reason
        return d
    return decision


# =============================================================================
# EXECUTED-STEP GATHERING + ATTRIBUTION (§20.2)
# =============================================================================

def _executed_steps(state: dict) -> List[dict]:
    """The step(s) whose output is pending this turn: a plan_tools wave (each
    step stamped with its wave index) or a single use_tool step."""
    plan = state.get("_current_plan")
    if plan and plan.get("steps"):
        out = []
        for i, s in enumerate(plan["steps"]):
            s2 = dict(s)
            s2["_step_index"] = i
            out.append(s2)
        return out
    single = state.get("_current_step")
    if single:
        s2 = dict(single)
        s2.setdefault("_step_index", 0)
        return [s2]
    return []


def _ordered_executing_children(tree: ExploitTree) -> List[ExploitTreeNode]:
    """Executing children in stable wave order (parent insertion order, then
    each parent's children order), so positional attribution to _current_plan
    steps is deterministic (§20.2)."""
    out = []
    for node in list(tree.nodes.values()):
        for cid in node.children:
            c = tree.nodes.get(cid)
            if c is not None and c.status == "executing":
                out.append(c)
    return out


def _step_ran(step: dict) -> bool:
    """A step produced a real result (ran), vs never left the harness."""
    return (step.get("tool_output") is not None
            or step.get("success") is not None
            or bool(step.get("error_message")))


def _match_children_to_steps(children, steps):
    """Pair each executing child with an executed step by tool_name (consuming
    each step once, in order). Returns [(child, step_or_None)]. Matching by
    tool_name (not blind position) is robust to a child stranded from a prior
    wave and to shadow mode, where the legacy step's tool_name differs (§20.2).
    """
    ran = [s for s in steps if _step_ran(s)]
    used = [False] * len(ran)
    pairs = []
    for child in children:
        match = None
        for j, s in enumerate(ran):
            if not used[j] and s.get("tool_name") == child.tool_name:
                used[j] = True
                match = s
                break
        pairs.append((child, match))
    return pairs


def _evaluate_wave(tree: ExploitTree, state: dict, analysis: Any) -> bool:
    """Evaluate + backprop the children we issued last turn, but ONLY those that
    ACTUALLY EXECUTED (§20.2). Returns True if at least one child produced a
    result (so the caller counts a rollout). Mutates the tree in place.

    Children that never ran this turn (no matching executed step) are reset to
    'proposed' so the search re-selects them (e.g. a metasploit probe re-routed
    to ask_user, §20.4) — leaving them 'executing' would strand them forever and
    skew later attribution.
    """
    children = _ordered_executing_children(tree)
    if not children:
        return False

    # Operator rejected the pending confirmation: prune, do NOT evaluate or
    # count a rollout (a rejection is not a probe result).
    if state.get("_reject_tool"):
        for child in children:
            child.status = "pruned"
            child.reflection = "operator declined"
        return False

    steps = _executed_steps(state)
    pairs = _match_children_to_steps(children, steps)
    executed = [(c, s) for c, s in pairs if s is not None]

    # Reset the never-ran children so they are re-selectable next turn.
    for child, step in pairs:
        if step is None:
            child.status = "proposed"

    if not executed:
        return False

    phase = state.get("current_phase")
    before, after = _post_expl_snapshots(state)
    prune_floor = get_setting("LATS_PRUNE_FLOOR", 0.15)

    # Which child, if any, is credited with the AGGREGATE wave-level signal
    # (exploit_succeeded / finding confidence). per_step localizes it; otherwise
    # credit the single strongest-signal child so we never mark every sibling
    # terminal (Bug: over-credit). A single executed step is always credited.
    credited_child = _credited_child(executed, analysis)

    for child, step in executed:
        credited = child is credited_child
        child.local_value = lats_value(step, analysis, phase=phase, before=before,
                                       after=after, credited=credited)
        child.observation_summary = _summarize(step.get("tool_output"))
        child.verdict = _verdict_for(step, analysis)
        child.error_class = step.get("error_class", "") or ""
        child.duration_ms = int(step.get("duration_ms", 0) or 0)
        child.step_id = step.get("step_id")
        child.finding_confidence_delta = _new_finding_confidence(step, analysis, credited)
        child.exploit_succeeded = _exploit_succeeded(step, analysis, credited)
        child.status = "terminal" if child.exploit_succeeded else "evaluated"
        lats_backprop(tree, child.id, child.local_value)
        if not child.exploit_succeeded and child.local_value < prune_floor:
            child.status = "pruned"
            child.reflection = _reflect(step, analysis)
    return True


def _credited_child(executed, analysis):
    """The single child credited with the aggregate wave signal. If any child
    already localizes the signal via per_step, no aggregate credit is given
    (return None). A single executed step is credited. Otherwise pick the
    strongest-signal child by its non-credited base value."""
    if len(executed) == 1:
        return executed[0][0]
    per_step = _attr(analysis, "per_step", []) or []
    if per_step:
        return None                     # per_step localizes; no blanket credit
    # No per-step attribution: credit the strongest child so exactly one can win.
    def _base(cs):
        c, s = cs
        return _lats_value_web(s, analysis, credited=False)
    return max(executed, key=_base)[0]


def _post_expl_snapshots(state: dict):
    """Cheap before/after engagement-state snapshots for post-exploitation
    scoring (§6.1). In v1 we compare the tree-persisted 'before' against the
    current state; when unavailable both are empty and the web value function
    is used anyway (phase != post_exploitation)."""
    ti = state.get("target_info", {}) or {}
    snap = {
        "sessions": ti.get("sessions", []),
        "credentials": ti.get("credentials", []),
        "hosts": ti.get("hosts", []) or ti.get("services", []),
    }
    # For v1 we do not diff across the fold; both snapshots equal, so the delta
    # helpers return 0 and post-expl value leans on _new_finding. Refined later.
    return snap, snap


def _as_wave_or_use_tool(decision: Any, wave: List[ExploitTreeNode]) -> Any:
    """Override the decision's action with the next LATS move: a plan_tools wave
    when >= 2 probes, else a single use_tool. Dangerous steps are allowed; the
    existing confirmation gate handles the prompt (§20.3).

    CRITICAL: for a real LLMDecision, `tool_plan` MUST be a ToolPlan model, not a
    dict — pydantic's model_copy does NOT coerce update values, and think_node
    calls `decision.tool_plan.model_dump()`. A dict there crashes the run.
    """
    is_wave = len(wave) >= 2
    if not is_wave and not wave:
        return decision   # nothing to issue; leave the decision alone

    if hasattr(decision, "model_copy"):
        if is_wave:
            from state import ToolPlan, ToolPlanStep
            plan = ToolPlan(steps=[
                ToolPlanStep(tool_name=k.tool_name, tool_args=k.tool_args or {},
                             rationale=k.probe_rationale)
                for k in wave
            ], plan_rationale="[LATS] wave")
            return decision.model_copy(update={"action": "plan_tools", "tool_plan": plan,
                                               "tool_name": None, "tool_args": None})
        best = wave[0]
        return decision.model_copy(update={"action": "use_tool",
                                           "tool_name": best.tool_name,
                                           "tool_args": best.tool_args or {},
                                           "tool_plan": None})
    # dict fallback (unit tests): keep the plain-dict shape for assertions.
    d = dict(decision)
    if is_wave:
        d["action"] = "plan_tools"
        d["tool_plan"] = _wave(wave)
    else:
        best = wave[0]
        d["action"] = "use_tool"
        d["tool_name"] = best.tool_name
        d["tool_args"] = best.tool_args or {}
    return d


# =============================================================================
# STREAMING (§17.4) — emit on_lats_* to the per-session StreamingCallback so the
# UI card mutates in place. Resilient: no-op when there is no callback (tests).
# =============================================================================

def _search_id(session_id: Optional[str], tree: ExploitTree) -> str:
    """Unique per session per search (§20.12). A tree created after a reset gets
    a new root_id, so a second search renders as a distinct card."""
    return f"{session_id or 'sess'}:{tree.root_id}"


def _tree_view(state: dict, tree: ExploitTree, shadow: bool) -> dict:
    return tree.to_view(
        search_id=_search_id(state.get("session_id"), tree),
        phase=state.get("current_phase", "") or "",
        shadow_mode=shadow,
        max_rollouts=int(get_setting("LATS_MAX_ROLLOUTS", 24)),
        max_depth=int(get_setting("LATS_MAX_DEPTH", 6)),
        best_trajectory=best_trajectory(tree),
    )


def _complete_metrics(tree: ExploitTree) -> dict:
    """A/B telemetry for on_lats_complete (§20.13)."""
    pruned = sum(1 for n in tree.nodes.values() if n.status == "pruned")
    max_depth = max((n.depth for n in tree.nodes.values()), default=0)
    return {
        "rollouts": tree.rollouts,
        "max_depth_reached": max_depth,
        "nodes_total": len(tree.nodes),
        "pruned_count": pruned,
        "outcome_terminal": tree.best_terminal_id is not None,
    }


async def _emit(streaming_callbacks: Any, session_id: Optional[str], method: str, *args) -> None:
    if not streaming_callbacks:
        return
    getter = getattr(streaming_callbacks, "get", None)
    cb = getter(session_id) if getter else None
    if cb is None:
        return
    fn = getattr(cb, method, None)
    if fn is None:
        return
    try:
        await fn(*args)
    except Exception as exc:   # streaming must never break the search
        logger.warning("[lats] stream %s failed: %s", method, exc)


# =============================================================================
# THE HOOK (§5.3) — runs inside think_node AFTER the think LLM call. Uses
# decision.output_analysis as the evaluation signal and (in DRIVE mode) overrides
# the action with the next LATS move. Strict no-op when LATS_ENABLED=false or
# when LATS is not driving. `llm` is the SAME single agent model think_node uses.
# =============================================================================

async def lats_hook(state: dict, decision: Any, *, llm: Any,
                    streaming_callbacks: Any = None, session_id: Optional[str] = None) -> Any:
    if not get_setting("LATS_ENABLED", False):
        return decision
    shadow = bool(get_setting("LATS_SHADOW_MODE", True))

    # ---- ENTER (no tree) or STAY (tree live) ----
    tree_dict = state.get("_exploit_tree")
    newly_created = False
    if not tree_dict:
        if not lats_active(state):
            return decision                              # legacy path, untouched
        probes = await lats_expand(llm, state, None)     # LATS's own assessment
        if len(probes) < int(get_setting("LATS_MIN_HYPOTHESES", 2)):
            return decision                              # < 2 credible probes: no real branch
        tree = _new_tree(state, probes)
        newly_created = True
    else:
        tree = ExploitTree(**tree_dict)
        if _lats_should_reset(state, tree):
            await _emit(streaming_callbacks, session_id, "on_lats_complete",
                        _search_id(session_id, tree), best_trajectory(tree),
                        "reset", _complete_metrics(tree))
            _archive_tree(state, tree, "stale")
            return decision                              # archived; fresh tree may start next turn

    if newly_created:
        await _emit(streaming_callbacks, session_id, "on_lats_start",
                    _search_id(session_id, tree), tree.objective,
                    state.get("current_phase", "") or "",
                    {"max_rollouts": int(get_setting("LATS_MAX_ROLLOUTS", 24)),
                     "max_depth": int(get_setting("LATS_MAX_DEPTH", 6))},
                    shadow)

    analysis = _attr(decision, "output_analysis")

    # ---- 1. EVALUATE + BACKPROP the wave we issued last turn ----
    if _evaluate_wave(tree, state, analysis):
        tree.rollouts += 1

    # ---- 2. EXITS (order matters: collapse hands off to legacy, budget completes) ----
    override = None
    outcome = None
    if any(n.status == "terminal" for n in tree.nodes.values()):
        tree.best_terminal_id = _best_terminal(tree)
        override, outcome = "lats_terminal_success", "terminal_success"
    elif _single_open_line(tree):
        await _emit(streaming_callbacks, session_id, "on_lats_complete",
                    _search_id(session_id, tree), best_trajectory(tree),
                    "branch_collapsed", _complete_metrics(tree))
        _archive_tree(state, tree, "branch_collapsed")
        return decision                                  # legacy drives the one obvious line
    elif _budget_hit(tree) or _tree_exhausted(tree):
        override, outcome = "lats_budget_exhausted", "budget_exhausted"

    # ---- 3. SELECT + 4. EXPAND (skip when exiting via complete) ----
    wave: List[ExploitTreeNode] = []
    if override is None:
        node = tree.nodes[lats_select(tree, get_setting("LATS_UCT_C", 1.4))]
        tree.active_node_id = node.id
        if _can_expand(node) and not _has_proposed_children(tree, node):
            max_nodes = int(get_setting("LATS_MAX_TREE_NODES", 60))
            for cand in await lats_expand(llm, state, node):
                if len(tree.nodes) >= max_nodes:
                    break
                _add_child(tree, node, cand)
        kids = _proposed_children(tree, node)
        wave = _mutex_safe_subset(kids)
        for k in wave:
            k.status = "executing"

    # ---- persist the tree + stream the snapshot (once per invocation = per wave) ----
    state["_exploit_tree"] = tree.model_dump()
    await _emit(streaming_callbacks, session_id, "on_lats_tree_update",
                _search_id(session_id, tree), _tree_view(state, tree, shadow))
    if outcome is not None:
        await _emit(streaming_callbacks, session_id, "on_lats_complete",
                    _search_id(session_id, tree), best_trajectory(tree),
                    outcome, _complete_metrics(tree))

    # ---- SHADOW: build/stream the tree but never drive ----
    if shadow:
        return decision

    # ---- DRIVE (Step 6): apply the override / next move ----
    if override is not None:
        return _complete(decision, tree, override)
    return _as_wave_or_use_tool(decision, wave)
