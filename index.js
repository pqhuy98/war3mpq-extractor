const glob = require("glob");
const globSync = require("glob/sync");
const fs = require("fs");

let extensions = {};

function last(arr) {
    return arr[arr.length - 1];
}

function print(arr, size) {
    for (let i = 0; i < size; i++) console.log(arr[i]);
}

function extract(pattern) {
    let filenames = globSync("extracted-mpq/" + pattern)
    filenames = filenames.map((s) => s.replace("extracted-mpq/", ""));

    let files = [];
    let nameSet = {};
    filenames.forEach((filename) => {
        let name = last(filename.split("/")).split(".")[0].replaceAll("-", "_");
        if (nameSet[name]) {
            nameSet[name]++;
            name += "_" + nameSet[name]
        } else {
            nameSet[name] = 1;
        }

        files.push({
            path: filename,
            name,
        })
    })

    return files
}

function main() {
    let files = extract("**/*.mdx");
    console.log(files)

    let strs = "";
    files.forEach((file) => strs += toCode(file));
    strs += `export const ALL_MODELS = [\n`
    files.forEach((file) => strs += "    MODEL_" + file.name + ",\n");
    strs += `];\n`

    fs.writeFileSync("./war3-models.ts", strs);
}
main();

function toCode(file) {
    return `export const MODEL_${file.name} = '${file.path}';\n`
}
