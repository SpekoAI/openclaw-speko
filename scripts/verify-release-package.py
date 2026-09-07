"""Verify and extract the exact built archive before the existing ClawHub publisher runs."""

import base64
import hashlib
import json
from pathlib import Path
import sys
import tarfile


def verify_package(root, artifacts, destination):
    package = json.loads((root / "package.json").read_text())
    plugin = json.loads((root / "openclaw.plugin.json").read_text())
    if package["name"] != "openclaw-plugin-speko" or plugin["id"] != "speko":
        raise ValueError("Unexpected package or runtime identity")
    if package["version"] != plugin["version"]:
        raise ValueError("Package and plugin versions differ")

    archives = list(artifacts.glob("*.tgz"))
    if len(archives) != 1:
        raise ValueError("Expected exactly one package archive")
    archive = archives[0]
    if archive.name != f"{package['name']}-{package['version']}.tgz":
        raise ValueError("Archive filename differs from package identity")

    sources = [root / name for name in ("package.json", "openclaw.plugin.json", "README.md", "LICENSE")]
    sources.extend(path for path in sorted((root / "dist").rglob("*")) if path.is_file())
    if not (root / "dist/index.js").is_file() or not (root / "dist/user-agent.js").is_file():
        raise ValueError("Built entrypoint or package marker is missing")
    if any(path.is_symlink() for path in sources):
        raise ValueError("Package source files must not be symbolic links")
    expected = {"package/" + path.relative_to(root).as_posix(): path.read_bytes() for path in sources}
    directories = {str(parent) for name in expected for parent in Path(name).parents if str(parent) != "."}
    contents = {}
    with tarfile.open(archive, "r:gz") as packed:
        for member in packed:
            if member.isdir() and member.name.rstrip("/") in directories:
                continue
            if not member.isfile() or member.name not in expected or member.name in contents:
                raise ValueError("Unexpected, duplicated, or unsafe archive member")
            if member.size != len(expected[member.name]):
                raise ValueError("Archive member size differs from the built file")
            data = packed.extractfile(member).read()
            if data != expected[member.name]:
                raise ValueError("Archive member bytes differ from the built file")
            contents[member.name] = data
    if contents.keys() != expected.keys():
        raise ValueError("Archive omits a built package file")

    destination.mkdir(parents=True, exist_ok=False)
    for name, data in contents.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    raw = archive.read_bytes()
    receipt = {
        "name": package["name"], "version": package["version"], "runtimeId": plugin["id"],
        "filename": archive.name, "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
        "npmIntegrity": "sha512-" + base64.b64encode(hashlib.sha512(raw).digest()).decode(),
        "files": [{"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                  for name, data in sorted(contents.items())],
    }
    (artifacts / "artifact-identity.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({key: value for key, value in receipt.items() if key != "files"}))


if __name__ == "__main__":
    verify_package(Path(__file__).resolve().parents[1], Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
