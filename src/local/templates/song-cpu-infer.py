"""Opt-in native CPU entry for Applio; copy to <rvc-root>/setup/.

Keeps short padded chunks and disables MKLDNN for hosts where ConvTranspose1d
crashes. AURABOT_RVC_CPU_THREADS is local to this subprocess, defaulting to 1.
Forward the same arguments that would follow `python core.py`.
"""
import os
from pathlib import Path
import runpy
import sys


def main():
    raw = os.environ.get("AURABOT_RVC_CPU_THREADS", "1")
    try:
        threads = int(raw)
    except ValueError:
        raise ValueError("AURABOT_RVC_CPU_THREADS must be a positive integer") from None
    if threads < 1:
        raise ValueError("AURABOT_RVC_CPU_THREADS must be a positive integer")
    os.environ["OMP_NUM_THREADS"] = str(threads)
    os.environ["MKL_NUM_THREADS"] = str(threads)
    import torch

    torch.backends.mkldnn.enabled = False
    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)
    project = Path(__file__).resolve().parents[1] / "Applio"
    os.chdir(project)
    sys.path.insert(0, str(project))
    from rvc.configs.config import Config

    config = Config()
    config.device = "cpu"
    config.x_query, config.x_center, config.x_max = 1, 6, 8
    print(f"CPU inference: native kernels, {threads} threads, short padded segments", flush=True)
    sys.argv = [str(project / "core.py"), *sys.argv[1:]]
    runpy.run_path(str(project / "core.py"), run_name="__main__")


if __name__ == "__main__":
    main()
