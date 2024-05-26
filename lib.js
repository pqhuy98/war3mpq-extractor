import globSync from "glob/sync.js";


export function last(arr) {
    return arr[arr.length - 1];
}

export function print(arr, size) {
    for (let i = 0; i < size; i++) console.log(arr[i]);
}

export function extract(pattern) {
    let filenames = globSync("extracted-mpq/" + pattern);
    filenames = filenames.map((s) => s.replace("extracted-mpq/", ""));

    const files = [];
    filenames.forEach((filename) => {
        const name = last(filename.split("/")).split(".")[0];
        const extension = last(filename.split("."));
        files.push({
            path: filename,
            name, extension: (extension !== filename ? extension : null)
        });
    });

    return files;
}