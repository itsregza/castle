import json

from castle import CastleError, generate_token

#example below for topps usa login (fanatics)

PK = "pk_xPQ5kRvjnzuTy24zZtig3eNMzspdJS92"
URL = "https://id.fanatics.com/"

try:
    print(json.dumps(generate_token(PK, URL).to_dict(), indent=2))
except CastleError as e:
    print(json.dumps({"error": str(e)}, indent=2))
