
const executeRealKagiSearch = async () => {
    const kagiSession = 'zFIdhYI3dgHFOpGFSQJpiyBm2E79EycFm8zInQAZOCI.QpesmZJlwedfWgT8FVBdyXmeF3QjwB87POHPRNLtbJA';
    const query = 'bitcoin price now';

    try {
        const encodedQuery = encodeURIComponent(query).replace(/%20/g, '+');

        console.log('Fetching Kagi...');
        const response = await fetch(`https://kagi.com/mother/context?q=${encodedQuery}`, {
            method: 'POST',
            headers: {
                'accept': 'application/vnd.kagi.stream',
                'accept-language': 'en-US,en;q=0.9',
                'cache-control': 'no-cache',
                'content-length': '0',
                'origin': 'https://kagi.com',
                'pragma': 'no-cache',
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
                'cookie': `kagi_session=${kagiSession}`
            }
        });

        if (!response.ok) {
            console.error('Kagi search error:', response.status, response.statusText);
            return;
        }

        const rawText = await response.text();
        console.log('Total response length:', rawText.length);
        console.log('--- RAW RESPONSE START ---');
        console.log(rawText.substring(0, 1000)); // Print first 1000 chars
        console.log('... (truncated) ...');

        // Test parsing logic
        let content = '';
        const sources = [];

        const lines = rawText.split(/\r?\n/);
        console.log('Total lines:', lines.length);

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith('new_message.json:')) {
                console.log('Found new_message.json line');
                const jsonStr = trimmedLine.substring('new_message.json:'.length);
                try {
                    // Log a snippet of the JSON string
                    console.log('JSON String Snippet:', jsonStr.substring(0, 100));

                    const data = JSON.parse(jsonStr);
                    console.log('Parsed JSON keys:', Object.keys(data));

                    if (data.references_md) {
                        console.log('Found references_md:', data.references_md.substring(0, 200) + '...');
                        const regex = /\[\^(\d+)\]:\s*\[(.*?)\]\((.*?)\)/g;
                        let match;
                        while ((match = regex.exec(data.references_md)) !== null) {
                            sources.push({
                                title: match[2],
                                url: match[3]
                            });
                        }
                    } else {
                        console.log('NO references_md found in this object');
                    }

                    if (data.md) {
                        content = data.md;
                        console.log('Found MD content length:', content.length);
                    }
                } catch (e) {
                    console.error('JSON parse error on line:', e.message);
                    // Log the characters around the end of the string
                    console.log('End of JSON string:', jsonStr.substring(jsonStr.length - 100));
                }
            }
        }

        console.log('Extracted Sources:', JSON.stringify(sources, null, 2));

    } catch (e) {
        console.error('Execution failed:', e);
    }
};

executeRealKagiSearch();
