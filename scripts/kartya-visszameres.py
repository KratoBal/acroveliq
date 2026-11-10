#!/usr/bin/env python3
"""kartya-visszameres.py: reads a kanban card's basis on stdin, measures it against the main branch, prints one JSON line.
The rules and what they do not measure: scripts/lib/kartya_visszameres.py. Driven by `fleet-api.sh kanban-visszameres`."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))
from kartya_visszameres import main  # noqa: E402

sys.exit(main())
