require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function testRetrieval(query) {
    console.log(`Testing query: "${query}"`);

    // 1. Try Full Text Search with current 'english' config
    const { data: searchData, error: searchError } = await supabase
        .from('knowledge')
        .select('content, source')
        .textSearch('content', query, {
            type: 'websearch',
            config: 'spanish'
        })
        .limit(3);

    if (searchError) {
        console.error('Error during text search:', searchError);
    } else {
        console.log(`Found ${searchData.length} results.`);
        searchData.forEach(d => console.log(`- [${d.source}] ${d.content.substring(0, 50)}...`));
    }
}

async function run() {
    await testRetrieval('hazme un resumen de los examenes que te entregue');
    await testRetrieval('hemograma');
}

run();
