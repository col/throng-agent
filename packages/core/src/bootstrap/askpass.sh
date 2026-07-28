#!/bin/sh
# Static file — no secrets inside. git invokes it with the prompt text as $1.
# Secret values arrive only via GIT_ASKPASS_USERNAME / GIT_ASKPASS_TOKEN env.
case "$1" in
  Username*) printf '%s' "${GIT_ASKPASS_USERNAME}" ;;
  Password*) printf '%s' "${GIT_ASKPASS_TOKEN}" ;;
esac
