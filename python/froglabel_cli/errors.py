from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ErrorContext:
    source: str | None = None
    record: int | None = None
    pointer: str | None = None
    repair: str | None = None


class FrogLabelCliError(RuntimeError):
    """Expected operator-facing error with stable context."""

    def __init__(self, code: str, message: str, *, context: ErrorContext | None = None):
        super().__init__(message)
        self.code = code
        self.context = context or ErrorContext()

    def render(self) -> str:
        location = ":".join(
            str(value)
            for value in (self.context.source, self.context.record, self.context.pointer)
            if value is not None
        )
        prefix = f"{location}: " if location else ""
        repair = f"\nRepair: {self.context.repair}" if self.context.repair else ""
        return f"[{self.code}] {prefix}{self}{repair}"
