#!/usr/bin/env python3
"""Runner wrapper for CodeScout Task Evaluations."""

import asyncio
from pathlib import Path
import sys

tasks_runner = Path(__file__).resolve().parent / "tasks" / "run_task_eval.py"
sys.path.insert(0, str(tasks_runner.parent))

from run_task_eval import main

if __name__ == "__main__":
    asyncio.run(main())

