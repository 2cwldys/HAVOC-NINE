"""The exception types every module raises, in one place.

They live here and not in h9chain.py on purpose. When the entry point runs as
'__main__', 'from .h9chain import Usage' binds h9chain.h9chain.Usage, which is
a DIFFERENT class object from the __main__ copy, so 'except Usage' in main()
never matches and the command dies with a traceback and exit 1. Importing them
from a leaf module makes that impossible.
"""


class Usage(Exception):
    """Bad arguments, an ambiguous selector, a refused rewrite -> exit 2."""

    def __init__(self, message, next_commands=None):
        Exception.__init__(self, message)
        self.next_commands = list(next_commands or [])


class Environment(Exception):
    """git too old, a path missing, the work root unusable -> exit 3."""


class Internal(Exception):
    """A bug in h9chain -> exit 5."""
