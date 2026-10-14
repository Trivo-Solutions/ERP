# Tiny test helpers. Every check prints: PASS|FAIL  <name>  | expected: ... | actual: ...   and counts.
pass=0; fail=0; FAILED_NAMES=""
check() { # check NAME EXPECTED ACTUAL RC   (RC=0 means the condition held)
  if [ "$4" = 0 ]; then pass=$((pass+1)); echo "PASS  $1 | expected: $2 | actual: $3"
  else fail=$((fail+1)); FAILED_NAMES="$FAILED_NAMES|$1"; echo "FAIL  $1 | expected: $2 | actual: $3"; fi
}
summary() { echo "RESULT pass=$pass fail=$fail${FAILED_NAMES:+  failed: $FAILED_NAMES}"; [ "$fail" = 0 ]; }
