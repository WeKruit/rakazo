"""C5 split service definitions. Not used by the existing production release entrypoint.

Deploying this file creates a worker Server and requires the reviewed initial data cutover.
Do not deploy until the immutable-home migration and serialized worker replacement gate pass.
"""
# Fail before importing Modal, resolving secrets or declaring any deployment resource.
# Removing this gate requires the tested home-pointer migration and a rollout controller
# that replaces one fully drained worker at a time within the aggregate session budget.
raise RuntimeError(
    "C5 split deployment is disabled: shared-home authority migration and serialized "
    "worker replacement have not been verified; keep the existing release entrypoint"
)
