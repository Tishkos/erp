# The live marker, for shell scripts — REQ-IMPROVE-001 OP-6 (IM4).
# Source this and call `refuse_on_live "what"` before the first write.
refuse_on_live() {
  local what="$1" marker
  for marker in "${APP:-/opt/qs-erp-next}/var/LIVE" "$(pwd)/var/LIVE" /opt/qs-erp-next/var/LIVE; do
    if [[ -e "$marker" ]]; then
      echo "Refusing to $what: $marker marks this database as the live books ($(cat "$marker" 2>/dev/null))." >&2
      echo "Trials belong on a separate database. If this really is not the live system any more, remove the marker by hand." >&2
      exit 1
    fi
  done
}
