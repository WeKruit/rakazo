#!/usr/bin/env bash
# Legacy production cutover stays disabled until an enforceable intake drain and
# writer barrier have been implemented and reviewed. Prior opt-ins cannot lift it.
set -Eeuo pipefail

printf '%s\n' 'Legacy Compose deployment is disabled: an enforceable intake drain and writer barrier are required before production cutover.' >&2
exit 1
