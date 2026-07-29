#!/usr/bin/env bash
# =============================================================================
# Unit tests for the memory-governor bash helpers in redamon.sh:
#   _size_to_mb / preflight_ram_gate / export_resource_caps / _export_clamped_cap
# Run:  bash tests/redamon_governor_test.sh
# detect_build_resources is stubbed so the gate/export logic is deterministic and
# needs no real Docker daemon.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1090
source "$REPO_ROOT/redamon.sh"
set +e   # redamon.sh turns on `set -e`; relax it so a non-zero return under test
         # (e.g. the gate returning 1) does not abort the harness.

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s (got: %s want: %s)\n' "$1" "$2" "$3"; }
eq()   { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }

# Silence info/warn/error output from the functions under test.
info()  { :; }; warn() { :; }; error() { :; }; success() { :; }

echo "== _size_to_mb =="
eq "2g -> 2048"        "$(_size_to_mb 2g)"        "2048"
eq "512m -> 512"       "$(_size_to_mb 512m)"      "512"
eq "512mb -> 512"      "$(_size_to_mb 512mb)"     "512"
eq "2G upper -> 2048"  "$(_size_to_mb 2G)"        "2048"
eq "1GB bytes -> 1024" "$(_size_to_mb 1073741824)" "1024"
eq "2048 bytes -> 0MB" "$(_size_to_mb 2048)"      "0"
eq "1.5g -> 1536"      "$(_size_to_mb 1.5g)"      "1536"
eq "0.5g -> 512"       "$(_size_to_mb 0.5g)"      "512"
eq "6.5g -> 6656"      "$(_size_to_mb 6.5g)"      "6656"
eq "empty -> empty"    "$(_size_to_mb '')"        ""
eq "garbage -> empty"  "$(_size_to_mb abc)"       ""

echo "== preflight_ram_gate =="
# Stub detected RAM.
STUB_MEM=0
detect_build_resources() { BUILD_MEM_MB="$STUB_MEM"; BUILD_RES_SOURCE="stub"; BUILD_NCPU=4; }

STUB_MEM=4096; unset REDAMON_MIN_RAM_MB REDAMON_SKIP_RAM_GATE SERVICE_BASELINE_MEM OS_HEADROOM_MEM
preflight_ram_gate; eq "4GB host fails default 8GB gate" "$?" "1"

STUB_MEM=16384
preflight_ram_gate; eq "16GB host passes gate" "$?" "0"

STUB_MEM=7700   # physical 8GB host reads ~7.7GB via docker info -> should pass (tolerance)
preflight_ram_gate; eq "8GB host (7700MB) passes via tolerance" "$?" "0"

STUB_MEM=4096; REDAMON_SKIP_RAM_GATE=1
preflight_ram_gate; eq "skip flag overrides" "$?" "0"
unset REDAMON_SKIP_RAM_GATE

STUB_MEM=10240; REDAMON_MIN_RAM_MB=12288
preflight_ram_gate; eq "explicit MIN_RAM_MB enforced" "$?" "1"
unset REDAMON_MIN_RAM_MB

STUB_MEM=0   # undetectable -> do not block
preflight_ram_gate; eq "undetectable RAM does not block" "$?" "0"

STUB_MEM=5120; SERVICE_BASELINE_MEM=2g; OS_HEADROOM_MEM=1g  # required 3072
preflight_ram_gate; eq "custom baseline+headroom passes" "$?" "0"
unset SERVICE_BASELINE_MEM OS_HEADROOM_MEM

echo "== export_resource_caps =="
STUB_MEM=32000
unset NEO4J_HEAP NEO4J_PAGECACHE NEO4J_MEM AGENT_MEM GVMD_MEM RECON_ORCHESTRATOR_MEM WEBAPP_MEM POSTGRES_MEM KALI_MEM
export_resource_caps
eq "NEO4J_HEAP clamped to ceil"  "$NEO4J_HEAP"      "4096m"   # 32000*15% = 4800 -> ceil 4096
eq "NEO4J_PAGECACHE = 3200m"     "$NEO4J_PAGECACHE" "3200m"   # 32000*10% = 3200
eq "NEO4J_MEM = heap+pc+1024"    "$NEO4J_MEM"       "8320m"   # 4096 + 3200 + 1024 overhead
eq "AGENT_MEM = 3840m"           "$AGENT_MEM"       "3840m"   # 32000*12% = 3840
eq "POSTGRES_MEM clamped ceil"   "$POSTGRES_MEM"    "1920m"   # 32000*6% = 1920 (< 2048 ceil)

# INVARIANT: neo4j container limit must exceed heap+pagecache (else JVM OOM-kill).
heap_n="${NEO4J_HEAP%m}"; pc_n="${NEO4J_PAGECACHE%m}"; mem_n="${NEO4J_MEM%m}"
if [[ "$mem_n" -gt $(( heap_n + pc_n )) ]]; then ok "NEO4J_MEM > heap+pagecache"; else bad "NEO4J_MEM > heap+pagecache" "$mem_n" ">$(( heap_n + pc_n ))"; fi

# Explicit override respected.
unset NEO4J_HEAP; NEO4J_HEAP="1g"
export_resource_caps
eq "explicit NEO4J_HEAP kept" "$NEO4J_HEAP" "1g"
unset NEO4J_HEAP NEO4J_MEM NEO4J_PAGECACHE

# HIGH fix: a large NEO4J_HEAP override must push NEO4J_MEM above heap+pagecache.
STUB_MEM=8000               # derived heap would be ~1200 -> clamp; user forces 6g
NEO4J_HEAP="6g"
unset NEO4J_MEM NEO4J_PAGECACHE
export_resource_caps
mem_n="${NEO4J_MEM%m}"
if [[ "$mem_n" -gt 6144 ]]; then ok "NEO4J_MEM accounts for 6g heap override"; else bad "NEO4J_MEM accounts for 6g heap override" "$mem_n" ">6144"; fi
unset NEO4J_HEAP NEO4J_MEM NEO4J_PAGECACHE

# Small host: floors apply.
STUB_MEM=4096
unset AGENT_MEM POSTGRES_MEM
export_resource_caps
eq "AGENT_MEM floored to 1024m" "$AGENT_MEM" "1024m"  # 4096*12% = 491 -> floor 1024

echo "== export_cpu_caps (#163) =="
CPU_VARS=(POSTGRES_CPUS NEO4J_CPUS KALI_CPUS RECON_ORCHESTRATOR_CPUS AGENT_CPUS WEBAPP_CPUS DOCKER_BROKER_CPUS)
# Isolate from the repo's real .env (an operator pin there must not skew the test).
CPU_TMP="$(mktemp -d)"; trap 'rm -rf "$CPU_TMP"' EXIT
SCRIPT_DIR="$CPU_TMP"
reset_cpu_stub() { unset "${CPU_VARS[@]}" BUILD_NCPU; STUB_NCPU="$1"; }
detect_build_resources() { BUILD_MEM_MB="$STUB_MEM"; BUILD_RES_SOURCE="stub"; BUILD_NCPU="$STUB_NCPU"; }

# The reported failure: a 4-vCPU VM. Every cap must land <= 4 or the daemon
# rejects `up` with "range of CPUs is from 0.01 to 4.00".
reset_cpu_stub 4; export_cpu_caps
eq "4 cores: NEO4J_CPUS 8 -> 4"  "$NEO4J_CPUS" "4"
eq "4 cores: KALI_CPUS 10 -> 4"  "$KALI_CPUS"  "4"
eq "4 cores: AGENT_CPUS 8 -> 4"  "$AGENT_CPUS" "4"
eq "4 cores: POSTGRES_CPUS kept" "$POSTGRES_CPUS" "4"
eq "4 cores: BROKER_CPUS kept"   "$DOCKER_BROKER_CPUS" "2"
over=""
for v in "${CPU_VARS[@]}"; do [[ "${!v}" -gt 4 ]] && over="$over $v=${!v}"; done
if [[ -z "$over" ]]; then ok "no cap exceeds host cores"; else bad "no cap exceeds host cores" "$over" "<=4"; fi

# Roomy host: the generous compose defaults must survive untouched.
reset_cpu_stub 16; export_cpu_caps
eq "16 cores: NEO4J_CPUS stays 8" "$NEO4J_CPUS" "8"
eq "16 cores: KALI_CPUS stays 10" "$KALI_CPUS"  "10"

# Single-core host: everything collapses to 1, never to 0 (0 would mean unlimited).
reset_cpu_stub 1; export_cpu_caps
eq "1 core: NEO4J_CPUS -> 1"  "$NEO4J_CPUS" "1"
eq "1 core: BROKER_CPUS -> 1" "$DOCKER_BROKER_CPUS" "1"

# Undetectable core count -> export nothing, leave the compose defaults alone.
reset_cpu_stub 0; export_cpu_caps
eq "0 cores: NEO4J_CPUS unset" "${NEO4J_CPUS:-unset}" "unset"

# An explicit shell override always wins over the clamp.
reset_cpu_stub 4; NEO4J_CPUS=2; export_cpu_caps
eq "shell override kept" "$NEO4J_CPUS" "2"

# A pin in .env must win too: compose ranks the shell environment ABOVE .env, so
# exporting a clamp here would silently override the operator's pinned value.
reset_cpu_stub 4; printf 'NEO4J_CPUS=3\n' > "$CPU_TMP/.env"; export_cpu_caps
eq ".env pin left to compose" "${NEO4J_CPUS:-unset}" "unset"
eq ".env pin does not block others" "$KALI_CPUS" "4"
rm -f "$CPU_TMP/.env"

# export_resource_caps must apply the CPU clamp even when RAM is undetectable
# (the memory branch bails out early; the CPU branch must not ride along).
reset_cpu_stub 4; STUB_MEM=0; export_resource_caps
eq "CPU clamp survives undetectable RAM" "$KALI_CPUS" "4"
unset "${CPU_VARS[@]}"; STUB_MEM=32000

echo "== setup_zram guards =="
# Default off -> pure no-op (returns 0, does nothing).
unset REDAMON_ENABLE_ZRAM
setup_zram; eq "disabled by default -> no-op" "$?" "0"

# Enabled but stub uname to non-Linux -> skips cleanly.
REDAMON_ENABLE_ZRAM=1
uname() { echo "Darwin"; }
setup_zram; eq "non-Linux host -> skip ok" "$?" "0"
unset -f uname
unset REDAMON_ENABLE_ZRAM

echo
echo "RESULT: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
