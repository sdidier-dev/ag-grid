#!/usr/bin/env node

/**
 * This script is used to generate and update assets for the chart gallery. You can edit the configuration in
 * gallery.json and then run `node generate-chart-gallery.js to automatically update the menu, create thumbnails and
 * create a dummy markdown page so that examples are picked up and generated by the example generator.
 *
 * Please ensure that the Gatsby website is running in develop mode if you would like to update thumbnails. By default
 * only thumbnails for changed charts will be generated, but you can provide the --force-thumbnails argument if you
 * would like to force all thumbnails to be regenerated.
 */

const fs = require('fs-extra');
const Path = require('path');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-core');

function hasArgument(name) {
    return process.argv.some(arg => arg === `--${name}`);
}

const options = {
    rootPageName: 'charts-overview',
    rootDirectory: `doc-pages/charts-overview`,
    galleryJsonFile: 'gallery.json',
    thumbnailDirectory: 'src/components/chart-gallery/thumbnails',
    encoding: 'utf8',
    menuJsonPath: 'doc-pages/licensing/menu.json',
};

(async () => {
    console.log('Generating gallery assets using gallery.json');

    const galleryConfig = getJson(Path.join(options.rootDirectory, options.galleryJsonFile));

    generateAllGalleryPage(galleryConfig);
    updateMenu(galleryConfig);
    await generateThumbnails(galleryConfig);

    console.log('Finished!');
})();

function generateAllGalleryPage(galleryConfig) {
    const contents =
        `---
title: "AG Charts Gallery"
comment: "This page is auto-generated by generate-chart-gallery.js to allow the chart gallery examples to be generated. It is ignored by the website."
---

${getExampleNames(galleryConfig).map(name => `<chart-example title='${name}' name='${toKebabCase(name)}' type='generated' options='{ "exampleHeight": "60vh" }'></chart-example>`).join('\n')}
`;

    writeFile(Path.join(options.rootDirectory, '_gallery.md'), contents);
}

function updateMenu(galleryConfig) {
    console.log('Updating menu...');

    const rootPath = `/${options.rootPageName}/`;
    const menu = getJson(options.menuJsonPath);
    const galleryObject = findItemWithUrl(menu, rootPath);

    galleryObject.items = Object.keys(galleryConfig).map(category => ({
        title: category,
        url: rootPath + `#${toKebabCase(category)}`,
        disableActive: true,
        // by including children but hiding them, the menu will still expand correctly when those children pages are open
        hideChildren: true,
        items: Object.keys(galleryConfig[category])
            .filter(name => !name.startsWith('_'))
            .map(name => ({
                title: name,
                url: `${rootPath}gallery/${toKebabCase(name)}/`,
            })),
    }));

    writeFile(options.menuJsonPath, JSON.stringify(menu, null, 2));
}

function getChangedDirectories() {
    const diffOutput = execSync(`git status -s`).toString()
        .split('\n')
        .map((s => s.substr(3)));
    const exampleFolder = `${options.rootDirectory}/examples/`;

    return diffOutput
        .filter(entry => entry.indexOf(exampleFolder) >= 0)
        .map(entry => entry.replace(new RegExp(`^.*?${exampleFolder}(.*?)/`), '$1'));
}

async function generateThumbnails(galleryConfig) {
    if (hasArgument('skip-thumbnails')) {
        console.log("Skipping thumbnails.");
        return;
    }

    const shouldGenerateAllScreenshots = hasArgument('force-thumbnails');

    console.log(`Generating ${shouldGenerateAllScreenshots ? 'all' : 'changed'} thumbnails...`);

    const startTime = Date.now();
    const { thumbnailDirectory } = options;
    const tempDirectory = Path.join(thumbnailDirectory, '..', 'thumbnails-temp');

    if (shouldGenerateAllScreenshots) {
        // to avoid upsetting Gatsby while we're processing thumbnails, we generate everything to a temp directory and
        // then switch them over

        if (fs.existsSync(tempDirectory)) {
            await fs.emptyDir(tempDirectory);
        } else {
            await fs.mkdir(tempDirectory);
        }
    }

    const changedDirectories = getChangedDirectories();
    const names = getExampleNames(galleryConfig);
    const outputDirectory = shouldGenerateAllScreenshots ? tempDirectory : thumbnailDirectory;
    const minThumbnailFileSize = 15 * 1024; //any smaller than 15k and it's probably blank

    const namesToGenerate = names
        .sort()
        .map(toKebabCase)
        .filter(name => shouldGenerateAllScreenshots || changedDirectories.indexOf(name) >= 0);

    for (let name of namesToGenerate) {
        try {
            const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ignoreHTTPSErrors: true  });
            const page = await browser.newPage();
            await page.setViewport({ width: 800, height: 570 });

            const url = `https://localhost:8000/example-runner/?library=charts&pageName=${options.rootPageName}&name=${name}&importType=packages&framework=javascript`;

            const path = Path.join(outputDirectory, `${name}.png`);
            const saveThumbnail = async () => {
                await page.goto(url, { waitUntil: 'networkidle2' });
                // Wait for JS on page to stop running.
                await page.waitForFunction(() => window.chart == null || window.chart.updatePending !== 0);
                await page.screenshot({ path });
            }

            const saveThumbnailWithRetry = async (retryCount) => {
                for (let i = 0; i < retryCount; i++) {
                    await saveThumbnail();

                    if(fs.statSync(path).size > minThumbnailFileSize) {
                        break;
                    }
                    console.log("retrying...");
                }
            }

            await saveThumbnailWithRetry(3);

            if(fs.statSync(path).size < minThumbnailFileSize) {
                console.log(`Could not generate valid thumbnail for ${name}`);
                console.log(url);
                process.exit(1);
            }

            browser.close();
            console.log(`Generated thumbnail for ${name}`);
        } catch (e) {
            console.error(`Failed to generate thumbnail for ${name}`, e);
        }
    }

    const getThumbnailName = name => `thumbnail${name.replace(/[^0-9A-Za-z]/g, '')}`;

    const indexFile =
        `${names.map(name => `import ${getThumbnailName(name)} from './${toKebabCase(name)}.png';`).join('\n')}

const thumbnails = {
${names.map(name => `    '${toKebabCase(name)}': ${getThumbnailName(name)},`).join('\n')}
}

export default thumbnails;`;

    writeFile(Path.join(outputDirectory, 'index.js'), indexFile);

    if (shouldGenerateAllScreenshots) {
        await fs.emptyDir(thumbnailDirectory);
        await fs.rmdir(thumbnailDirectory);
        await fs.rename(tempDirectory, thumbnailDirectory);
    }

    console.log(`Finished generating thumbnails in ${(Date.now() - startTime) / 1000}s`);
}

function getExampleNames(galleryConfig) {
    return Object.keys(galleryConfig)
        .reduce((names, c) => names.concat(Object.keys(galleryConfig[c])), [])
        .map((name) => name.startsWith('_') ? name.substr(1) : name);
}

function findItemWithUrl(items, url) {
    for (let i = 0; i < items.length; i++) {
        const item = items[i];

        if (item.url === url) {
            return item;
        }
    }

    for (let i = 0; i < items.length; i++) {
        const children = items[i].items;

        if (children) {
            const item = findItemWithUrl(children, url);

            if (item) {
                return item;
            }
        }
    }

    return null;
}

function toKebabCase(name) {
    return name.replace(/ \w/g, v => `-${v.trim().toLowerCase()}`).replace(/[^\w]/g, '-').toLowerCase();
}

function getJson(path) {
    return JSON.parse(fs.readFileSync(path, { encoding: options.encoding }));
}

function writeFile(path, contents) {
    const { encoding } = options;

    if (fs.existsSync(path) && fs.readFileSync(path, { encoding }) === contents) {
        return;
    }

    fs.writeFileSync(path, contents, encoding, err => {
        if (err) {
            console.log(`An error occurred when writing to ${path} :(`);
            return console.log(err);
        }
    });
}
