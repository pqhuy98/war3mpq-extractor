import fs from 'fs';
import { extract } from "./lib.js";

function toCode(file) {
    return `export const MODEL_${file.name} = '${file.path}';\n`
}



function extractModel() {
    let files = extract("**/*").filter(f => f.extension && f.extension.toLowerCase() === "mdx");

    let nameSet = {};
    files.forEach(file => {
        let name = file.name.replaceAll("-", "_");
        if (nameSet[name]) {
            nameSet[name]++;
            name += "_" + nameSet[name]
        } else {
            nameSet[name] = 1;
        }
        file.name = name;
    })


    let strs = "";
    files.forEach((file) => strs += toCode(file));
    strs += `export const ALL_MODELS = [\n`
    files.forEach((file) => strs += "    MODEL_" + file.name + ",\n");
    strs += `];\n`

    fs.writeFileSync("./output/war3-models.ts", strs);
    console.log("Extracted", files.length, "model paths to ./war3-models.ts")
}
extractModel();

