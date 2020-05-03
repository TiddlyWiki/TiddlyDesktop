#!/bin/bash

# Update package.json to the SHA of the latest tiddlywiki commit to master

# This should be executed whenever there's an update to TW5 that we need to incorporate in ePub2TW5

read -r -d '' VAR << EOM
var fs = require("fs"),
	json = JSON.parse(fs.readFileSync("./package.json")),
	ref = json.dependencies.tiddlywiki.split("#");
json.dependencies.tiddlywiki = ref[0] + "#" + process.argv[1];
fs.writeFileSync("./package.json",JSON.stringify(json,null,4),"utf8");
EOM

node -e "$VAR" $(git ls-remote --q https://github.com/Jermolene/TiddlyWiki5.git master | head -c 40)

npm install
