import fs from 'fs';

let lines = fs.readFileSync("manual-data/unit-id.txt")
    .toString().replaceAll("\r", "").split("\n").filter(s => s.length)

const nameSet = new Map()

let units = lines.map((line, i) => {
    let strs = line.split("\t")
    if (strs.length !== 2) {
        console.log("len !== 2", strs)
        throw new Error(strs)
    }

    let name = `UNIT_${formatName(strs[1])}`
    if (nameSet.has(name)) {
        const idx = nameSet.get(name) + 1
        nameSet.set(name, idx)
        name += "_" + idx;
    } else {
        nameSet.set(name, 1)
    }

    return {
        name,
        code: strs[0],
    }
})

function formatName(str) {
    return str
        .replace(/[^\w]/g, " ")
        .split(" ")
        .filter(s => s.length > 0)
        .map(s => s[0].toUpperCase() + s.slice(1))
        .join("")
}

let code = `
export interface UNIT_TYPE {
    code: string;
}
`;
let code2 = "export const ALL_UNIT_TYPES = [\n";
units.forEach((unit) => {
    code += `export const ${unit.name}: UNIT_TYPE = ${JSON.stringify({
        code: unit.code,
    }, null, 2)};\n`

    code2 += `  ${unit.name},\n`
})

fs.writeFileSync("./output/war3-units.ts", code + code2 + "];\n")
console.log(`Extracted ${lines.length} units.`)