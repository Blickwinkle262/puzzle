"""Custom exceptions for story generator pipeline."""


class PipelineError(RuntimeError):
    """Raised when pipeline input/output contract is violated."""
