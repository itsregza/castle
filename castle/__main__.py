import argparse
import json
import sys

from .collector import build_collector
from .runtime.profiles import available_profiles, profile_dir
from .token import CastleError, generate_token


def cmd_token(args) -> int:
    try:
        result = generate_token(args.pk, args.url, args.ua, args.lang)
    except CastleError as e:
        print(json.dumps({"error": str(e)}, indent=2))
        return 1
    print(json.dumps(result.to_dict(), indent=2))
    return 0


def cmd_profiles(args) -> int:
    found = available_profiles()
    if not found:
        print(f"no profiles in {profile_dir()}")
        return 1
    for p in found:
        if p["ok"]:
            print(f"{p['path']}\n  {p['userAgent']}\n  {p['renderer']}")
        else:
            print(f"{p['path']}\n  invalid: {p['error']}")
    return 0


def cmd_collector(args) -> int:
    source = build_collector()
    if args.out == "-":
        sys.stdout.write(source)
    else:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(source)
        print(f"wrote {args.out}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="castle")
    sub = parser.add_subparsers(dest="command", required=True)

    token = sub.add_parser("token", help="generate a request token")
    token.add_argument("pk", help="site's Castle publishable key (pk_...)")
    token.add_argument("url", help="page URL the token is generated for")
    token.add_argument("--ua", default="", help="pick a profile matching this user agent")
    token.add_argument("--lang", default="", help="Accept-Language override, e.g. en-US,en;q=0.9")
    token.set_defaults(run=cmd_token)

    profiles = sub.add_parser("profiles", help="list available browser profiles")
    profiles.set_defaults(run=cmd_profiles)

    collector = sub.add_parser("collector", help="build the DevTools profile collector script")
    collector.add_argument("-o", "--out", default="collector.js", help="output file, - for stdout")
    collector.set_defaults(run=cmd_collector)

    args = parser.parse_args()
    try:
        return args.run(args)
    except CastleError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
