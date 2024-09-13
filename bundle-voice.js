import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';

ffmpeg.setFfmpegPath('bin\\ffmpeg-7.0.2-essentials_build\\bin\\ffmpeg.exe');
ffmpeg.setFfprobePath('bin\\ffmpeg-7.0.2-essentials_build\\bin\\ffprobe.exe');

// Directory where your input files are located
const inputDir = 'manual-data\\voice-packs\\Grunt';
const silenceFilePath = 'manual-data\\voice-packs\\silence.wav'; // Path to the pre-generated silent audio file
const delaySeconds = 1; // Delay in seconds between each file

// Function to combine audio files
const combineAudioFiles = (fileList, silenceFile, outputPath) => {
    let command = ffmpeg();

    fileList.forEach((file, index) => {
        command = command.input(file);
        if (index < fileList.length - 1) {
            command = command.input(silenceFile);
        }
    });

    command
        .on('end', () => {
            console.log('Files have been merged successfully');
        })
        .on('error', (err) => {
            console.log('Error merging files:', err.message);
        })
        .mergeToFile(outputPath);
};

// Get all mp3 and wav files in the directory
const getAudioFiles = (dir) => {
    return fs.readdirSync(dir)
        .filter(file => file.endsWith('.mp3') || file.endsWith('.wav'))
        .map(file => path.join(dir, file));
};

// Main function
const main = () => {
    const audioFiles = getAudioFiles(inputDir);
    if (audioFiles.length === 0) {
        console.log('No audio files found in the directory.');
        return;
    }

    const outputFile = 'output.mp3'; // Change to desired output path and format
    combineAudioFiles(audioFiles, silenceFilePath, outputFile);
};

main();