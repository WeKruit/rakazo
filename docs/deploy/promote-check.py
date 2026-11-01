"""Staging → production sync check, run before every production deploy.

Compares the environment of the test app with production's, by key name only, and checks that no
production value points at a test-environment address. Values never leave Modal; only key names and
pass/fail lines are printed.

    python3 docs/deploy/promote-check.py        # exit 1 when production is missing a key or leaks a test address

Keys listed in TEST_ONLY exist on the test environment by design and are never expected in production.
"""

import sys

import modal

# Keys that only the test environment has (its own DB secret, release markers).
TEST_ONLY = {"RAKAZO_TEST_ENVIRONMENT"}
# Substrings that must never appear in a production value.
TEST_MARKERS = ("headhunter-stage.", "wekruit-recruiting-test", "-test--")
# Runtime keys every Modal container has; they are not configuration.
RUNTIME_PREFIXES = ("MODAL_", "PYTHON", "HOSTNAME", "HOME", "PATH", "LANG", "PWD", "SHLVL", "TERM", "_", "SSL_", "GPG_")

ENVS = {
    "test": ("test", ["wekruit-recruiting-test-config", "wekruit-recruiting-test-db"]),
    "prod": ("main", ["wekruit-recruiting-config"]),
}


def keys_and_leaks(env_name, secret_names):
    app = modal.App(f"promote-check-{env_name}")
    secrets = [modal.Secret.from_name(name, environment_name=env_name) for name in secret_names]

    @app.function(secrets=secrets, serialized=True)
    def inspect(markers):
        import os

        keys = sorted(k for k in os.environ if not k.startswith(RUNTIME_PREFIXES))
        leaks = sorted(k for k in keys if any(m in os.environ[k] for m in markers))
        return keys, leaks

    with app.run(environment_name=env_name):
        return inspect.remote(TEST_MARKERS)


def main():
    test_keys, _ = keys_and_leaks(*ENVS["test"])
    prod_keys, prod_leaks = keys_and_leaks(*ENVS["prod"])
    missing = sorted(set(test_keys) - set(prod_keys) - TEST_ONLY)
    prod_only = sorted(set(prod_keys) - set(test_keys))
    print(f"test keys {len(test_keys)}, prod keys {len(prod_keys)}")
    for key in missing:
        print(f"MISSING IN PROD {key}")
    for key in prod_only:
        print(f"prod only {key}")
    for key in prod_leaks:
        print(f"LEAK prod {key} points at the test environment")
    if missing or prod_leaks:
        print("PROMOTE CHECK FAILED: add the missing keys to production (or to TEST_ONLY) and fix leaks first")
        return 1
    print("PROMOTE CHECK OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
