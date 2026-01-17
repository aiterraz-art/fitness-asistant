const axios = require('axios');


async function downloadFile(url) {
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'arraybuffer'
    });
    return response.data;
}

module.exports = { downloadFile };
