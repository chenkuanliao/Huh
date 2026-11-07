"""Generate an optional Linux GPU override without changing the host or Docker daemon.

Run: python3 scripts/configure-host-gpu.py
Prefer NVIDIA Container Toolkit on other hosts; this is an explicit local alternative.
"""
import glob
import json
import pathlib
import re
import subprocess

root = pathlib.Path(__file__).resolve().parent.parent
listing = subprocess.check_output(["/sbin/ldconfig", "-p"], text=True)
libraries = {}
for line in listing.splitlines():
    match = re.match(r"\s*(\S+) .* => (\S+)", line)
    if not match:
        continue
    name, path = match.groups()
    if name in ("libcuda.so.1", "libnvidia-ml.so.1", "libnvidia-ptxjitcompiler.so.1", "libnvidia-nvvm.so.4") or name.startswith("libnvidia-gpucomp.so."):
        libraries[name] = str(pathlib.Path(path).resolve())
if "libcuda.so.1" not in libraries:
    raise SystemExit("NVIDIA driver library not found. Install the host driver first.")
devices = sorted(glob.glob('/dev/nvidia[0-9]*')) + ['/dev/nvidiactl', '/dev/nvidia-uvm']
if not all(pathlib.Path(x).exists() for x in devices) or len(devices) < 3:
    raise SystemExit("NVIDIA GPU and UVM devices are required; ensure the driver is loaded.")
lines = ["# Generated for this host. Regenerate after NVIDIA driver upgrades.", "services:", "  worker:", "    gpus: !reset []", "    environment:", "      NVIDIA_VISIBLE_DEVICES: void", "      LD_LIBRARY_PATH: /opt/host-nvidia:/usr/local/cuda/lib64:/usr/local/cuda/targets/x86_64-linux/lib", "    devices:"]
lines.extend('      - ' + json.dumps(f'{x}:{x}') for x in devices)
lines.append('    volumes:')
lines.extend('      - ' + json.dumps(f'{path}:/opt/host-nvidia/{name}:ro') for name, path in libraries.items())
target = root / 'compose.host-gpu.yaml'
target.write_text('\n'.join(lines) + '\n')
print(f'Created {target.name}: {len(devices)} device nodes, {len(libraries)} read-only driver libraries.')
print('Start with: docker compose -f compose.yaml -f compose.host-gpu.yaml up -d --build')
