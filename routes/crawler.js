const express = require("express");
const router = express.Router();
const firedb = require('../firebase/fire.js')
const cron = require('node-cron');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())
const TfIdf = require('tf-idf-search');


const {
    KMA
} = require("./KMA");


// focused crawler and ranking
// crawlerOpt : 0 : sage, 1: scd, 2:ieee, 3:acd
async function crawlAndRank (keyword, ogKeyword, searchFactors = [], headless, yearStart, yearEnd, crawlerOpt = 1) {
    let results = []
    let simpleKeyword = '-' // untuk journal evaluation
    if (ogKeyword === '-') {
        // search biasa
        simpleKeyword = keyword
        if (simpleKeyword.includes('&')) {
            return {
                'error': 'app',
                'msg': 'Application Error'
            }
        }
    } else {
        // advanced search
        simpleKeyword = ogKeyword
    }

    // Crawl 
    try{
        // setting up puppeteer
        const browser = await puppeteer.launch({
            'args' : [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--start-maximized',
            ],
            defaultViewport: null,
            headless: headless
        })
        const page = await browser.newPage()

        // crawl bedasarkan crawl opt
        if (crawlerOpt === 0) {
            // crawler sage 
            if(yearStart !== '-' && yearEnd !== '-') {
                yearStart = '1987'
                yearEnd = '2023'
            } else if (yearStart !== '-') {
                yearStart = '1987'
            } else if (yearEnd !== '-') {
                yearEnd = '2023'
            }
    
            let crawlInfo = {
                search_res_links: [],
                pageNum : 0,
                attempt : 1,
                yearStart: yearStart,
                yearEnd: yearEnd,
                simpleKeyword: simpleKeyword
            }
    
            results = await sageCrawl(page, keyword, crawlInfo)  
        } else if (crawlerOpt === 1) {
            // crawler SCD
            let date = ''
            if(yearStart !== '-' && yearEnd !== '-') {
                date = yearStart + '-' + yearEnd
            } else if (yearStart !== '-') {
                date = yearStart + '-2023'
            } else if (yearEnd !== '-') {
                date = '1990-' + yearEnd 
            }
    
            let crawlInfo = {
                search_res_links: [],
                pageNum : 1,
                attempt : 1,
                date: date,
                simpleKeyword: simpleKeyword
            }
    
            results = await scienceDirectCrawl(page, keyword, crawlInfo)  
        } else if (crawlerOpt === 2) {
            // IEEE Crawler
            date = ''
            if(yearStart !== '-' && yearEnd !== '-') {
                date = `&ranges=${yearStart}_${yearEnd}_Year`
            } else if (yearStart !== '-') {
                date = `&ranges=${yearStart}_2023_Year`
            } else if (yearEnd !== '-') {
                date = `&ranges=1884_${yearEnd}_Year`
            }

            crawlInfo = {
                search_res_links: [],
                pageNum : 1,
                attempt : 1,
                date: date,
                simpleKeyword: simpleKeyword
            }

            results = await ieeeCrawl(page, keyword, crawlInfo)
        } else if (crawlerOpt === 3) {
            // ACD Crawl
            if (ogKeyword === '-') {
                // search biasa
                keyword = 'q=' + keyword
            } else {
                // advanced search
                keyword = 'cqb=' + keyword
            }

            date = ''
            if(yearStart !== '-' && yearEnd !== '-') {
                date = `&rg_ArticleDate=01/01/${yearStart}%20TO%2012/31/${yearEnd}&dateFilterType=range&noDateTypes=true&rg_SearchResultsPublicationDate=01/01/${yearStart}%20TO%2012/31/${yearEnd}&rg_VersionDate=01/01/${yearStart}%20TO%2012/31/${yearEnd}`
            } else if (yearStart !== '-') { 
                date = `&rg_ArticleDate=01/01/${yearStart}%20TO%2012/31/2999&dateFilterType=range&noDateTypes=true&rg_SearchResultsPublicationDate=01/01/${yearStart}%20TO%2012/31/2999&rg_VersionDate=01/01/${yearStart}%20TO%2012/31/2999`
            } else if (yearEnd !== '-') {
                date = `&rg_ArticleDate=01/01/1980%20TO%2012/31/${yearEnd}&dateFilterType=range&noDateTypes=true&rg_SearchResultsPublicationDate=01/01/1980%20TO%2012/31/${yearEnd}&rg_VersionDate=01/01/1980%20TO%2012/31/${yearEnd}`
            }

            crawlInfo = {
                search_res_links: [],
                pageNum : 1,
                attempt : 1,
                date: date
            }

            results = await academicCrawl(page, keyword, crawlInfo)
        }
    
        await browser.close()    
    }catch(e) {
        console.log(e.name)
        if (e.name === 'TimeoutError') {
            return {
                'error': 'timeout',
                'msg': 'Crawler Website Timeout, Please Refresh The Page'
            }
        }
        return {
            'error': 'crawl',
            'msg': 'Crawler Crashed'
        }
    }

    // focused crawl (cosinus similarity)
    // cosinusKeyword = simpleKeyword + search factor
    let cosinusKeyword = simpleKeyword
    let sfKeyword = ''
    if (searchFactors.length > 0) {
        sfKeyword = searchFactors[0].sub_factor // pure sf keyword
        for (let i = 0; i < searchFactors.length; i++) {
            if (i > 0) {
                sfKeyword += ' ' + searchFactors[i].sub_factor
            }
            cosinusKeyword += ' ' + searchFactors[i].sub_factor
        }
        sfKeyword.toLowerCase()
    }
    cosinusKeyword.toLowerCase()

    console.log('"' + cosinusKeyword + '"')
    console.log('"' + sfKeyword + '"')

    if (results.length > 0) {
        // journal valuation
        journalsEvaluation(results, cosinusKeyword, simpleKeyword, sfKeyword, searchFactors, crawlerOpt)
    
        // ranking with KMA
        results = KMA(results, results.length, Math.ceil(results.length / 2) + 5, 100, 5, crawlerOpt) 
    }
    
    return results
}

// insert new semua results dari hasil crawl dan ranking dan assign ke user_log_id
async function addJournalsResult (userLogId, results) {
    for (let i = 0; i < results.length; i++) {
        await firedb.collection('journals_result').add({
            rank: (i + 1),
            user_log_id: userLogId,
            g_id: results[i].journal.g_id,
            title: results[i].journal.title,
            content: results[i].journal.content,
            authors: results[i].journal.authors,
            publisher: results[i].journal.publisher,
            publish_year: results[i].journal.publish_year,
            free: results[i].journal.free,
            link: results[i].journal.link,
            pdf: results[i].journal.pdf,
            site: results[i].journal.site,
            cited_count: results[i].journal.cited_count,
            status: 1,
            created_at: new Date(),
            deleted_at: null
        });
    }
}


// DIJALANIN LOCAL, untuk update hasil crawl keterbaru
let READY = false
cron.schedule('0 1 * * 0', async function() {
    console.log('running a task every sunday, ready : ' + READY);
    if (READY) {
        // semua user logs yang status 2 dilakukan fully focused cralwer dan ranked
        let query = await firedb.collection('user_logs')
        query = query.where('status', '==', 2)
        const resu = await query.get()

        let user_logs = []
        resu.forEach((doc) => {
            user_logs.push({
                id: doc.id,
                user_id: doc.data().user_id,
                keyword: doc.data().keyword,
                og_keyword: doc.data().og_keyword,
                factors: doc.data().factors,
                year_start: doc.data().year_start,
                year_end: doc.data().year_end,
                crawler_opt: doc.data().crawler_opt,
                status: doc.data().status,
                created_at: doc.data().created_at,
                deleted_at: doc.data().deleted_at
            })
        });

        READY = false
        for (let i = 0; i < user_logs.length; i++) {
            // update user logs status lagi update, status = 3
            await firedb.collection('user_logs').doc(`${user_logs[i].id}`).set({
                user_id: user_logs[i].user_id,
                factors: user_logs[i].factors,
                keyword: user_logs[i].keyword,
                og_keyword: user_logs[i].og_keyword, 
                year_start: user_logs[i].year_start,
                year_end: user_logs[i].year_end,
                crawler_opt: user_logs[i].crawler_opt, 
                status: 3,  // processing update (crawl and ranked)
                created_at: new Date(),
                deleted_at: null
            })
            // delete semuanya dulu
            await deleteJournalsResult(user_logs[i].id)
            // crawl and rank yang terbaru, dan berdasarkan settingan crawl opt
            const results = await crawlAndRank(user_logs[i].keyword, user_logs[i].og_keyword, user_logs[i].factors, true, user_logs[i].year_start, user_logs[i].year_end, parseInt(user_logs[i].crawler_opt))
            // add hasil terbaru
            await addJournalsResult(user_logs[i].id, results)
            // update user logs status
            await firedb.collection('user_logs').doc(`${user_logs[i].id}`).set({
                user_id: user_logs[i].user_id,
                factors: user_logs[i].factors,
                keyword: user_logs[i].keyword,
                og_keyword: user_logs[i].og_keyword, 
                year_start: user_logs[i].year_start,
                year_end: user_logs[i].year_end,
                crawler_opt: user_logs[i].crawler_opt, 
                status: 1,  // fully crawled and ranked / sudah diup to date
                created_at: new Date(),
                deleted_at: null
            })
        }
        READY = true
    }
}, {
    timezone: "Asia/Jakarta"
});

// set status to 2 untuk diperbarui
cron.schedule('0 1 * * 3', async function() {
    console.log('running a task every wednesday')
    // semua user logs yang status 1
    let query = await firedb.collection('user_logs')
    query = query.where('status', '==', 1)
    const resu = await query.get()

    let user_logs = []
    resu.forEach((doc) => {
        user_logs.push({
            id: doc.id,
            user_id: doc.data().user_id,
            keyword: doc.data().keyword,
            og_keyword: doc.data().og_keyword,
            factors: doc.data().factors,
            year_start: doc.data().year_start,
            year_end: doc.data().year_end,
            crawler_opt: doc.data().crawler_opt,
            status: doc.data().status,
            created_at: doc.data().created_at,
            deleted_at: doc.data().deleted_at
        })
    });

    
    for (let i = 0; i < user_logs.length; i++) {
        // update user logs status back to 2
        await firedb.collection('user_logs').doc(`${user_logs[i].id}`).set({
            user_id: user_logs[i].user_id,
            factors: user_logs[i].factors,
            keyword: user_logs[i].keyword,
            og_keyword: user_logs[i].og_keyword, 
            year_start: user_logs[i].year_start,
            year_end: user_logs[i].year_end,
            crawler_opt: user_logs[i].crawler_opt, 
            status: 2,  // set for update
            created_at: new Date(),
            deleted_at: null
        })
    }
}, {
    timezone: "Asia/Jakarta"
});

async function deleteJournalsResult(userLogId) {
    let hasil = []
    let query = await firedb.collection('journals_result')
    query = query.where('user_log_id', '==', userLogId)
    const resu = await query.get()
    
    resu.forEach((doc) => {
        hasil.push({
            id: doc.id
        })
    });
    
    for (let i = 0; i < hasil.length; i++) {
        await firedb.collection('journals_result').doc(hasil[i].id).delete()
    }
}

router.post('/scheduler', async (req, res) => {
    // semua user logs yang status 2 dilakukan fully focused cralwer dan ranked
    let query = await firedb.collection('user_logs')
    query = query.where('status', '==', 3)
    const resu = await query.get()

    let user_logs = []
    resu.forEach((doc) => {
        user_logs.push({
            id: doc.id,
            user_id: doc.data().user_id,
            keyword: doc.data().keyword,
            og_keyword: doc.data().og_keyword,
            factors: doc.data().factors,
            year_start: doc.data().year_start,
            year_end: doc.data().year_end,
            crawler_opt: doc.data().crawler_opt,
            status: doc.data().status,
            created_at: doc.data().created_at,
            deleted_at: doc.data().deleted_at
        })
    });

    console.log(user_logs)
    for (let i = 0; i < user_logs.length; i++) {
        // delete semuanya dulu
        await deleteJournalsResult(user_logs[i].id)
        // crawl and rank yang terbaru, dan berdasarkan settingan crawl opt
        const results = await crawlAndRank(user_logs[i].keyword, user_logs[i].og_keyword, user_logs[i].factors, true, user_logs[i].year_start, user_logs[i].year_end, parseInt(user_logs[i].crawler_opt))
        // add hasil terbaru
        await addJournalsResult(user_logs[i].id, results)
        // update user logs status
        await firedb.collection('user_logs').doc(`${user_logs[i].id}`).set({
            user_id: user_logs[i].user_id,
            factors: user_logs[i].factors,
            keyword: user_logs[i].keyword,
            og_keyword: user_logs[i].og_keyword, 
            year_start: user_logs[i].year_start,
            year_end: user_logs[i].year_end,
            crawler_opt: user_logs[i].crawler_opt, 
            status: 1,  // fully crawled and ranked / sudah diup to date
            created_at: new Date(),
            deleted_at: null
        })
    }
})



const MAX_RESET = 4

// sage crawler setup
const MAX_PAGE_SAGE = 3 // per page 100
let MAX_CRAWL_DATA_SAGE = 30

// target 'https://journals.sagepub.com'
async function sageCrawl(page, keyword, crawlInfo) {
    while (crawlInfo.pageNum < MAX_PAGE_SAGE && crawlInfo.attempt < MAX_RESET) {
        console.log("Page num : " + crawlInfo.pageNum)
        
        await Promise.all([
            page.waitForNavigation(),
            page.goto(`https://journals.sagepub.com/action/doSearch?AllField=${keyword}&access=18&startPage=${crawlInfo.pageNum}&rel=nofollow&ContentItemType=research-article&ContentItemType=other&pageSize=100&AfterYear=${crawlInfo.yearStart}&BeforeYear=${crawlInfo.yearEnd}`, {
                waitUntil: 'domcontentloaded'
            }),
        ])
    
        try {
            await page.waitForSelector('.rlist.search-result__body.items-results', {
                timeout: 5000
            })
        } catch (e) {
            // empty search
            return crawlInfo.search_res_links
        }
    
        const pageURL = page.url()
    
        let searchResRaw = ''
        try{
            searchResRaw = await page.$$eval(".issue-item", (results) => {
                const temp = []
                for (let i = 0; i < results.length; i++) {
                    // dapatin html
                    temp.push(results[i].innerHTML + "")
                }
                return temp
            })

            for (let i = 0; i < searchResRaw.length; i++) {
                if (crawlInfo.search_res_links.length === MAX_CRAWL_DATA_SAGE) {
                    return crawlInfo.search_res_links
                }
                const $ = await cheerio.load(searchResRaw[i] + "")
        
                const detailJournalPath = $("a.sage-search-title").attr("href")
                console.log(detailJournalPath)
            
                // obtaining journal info detail
                try {
                    // masuk ke detail journal
                    await Promise.all([
                        page.waitForNavigation(),
                        page.goto(pageURL.substring(0, pageURL.indexOf('/', 10)) + detailJournalPath, {
                            waitUntil: 'domcontentloaded'
                        }), page.waitForSelector(".content > article", {
                            timeout: 8000
                        })
                    ])
        
                    const body = await page.$eval(`body`, (result) => {
                        return result.innerHTML
                    })
                    
                    const jq = await cheerio.load(body + "")

                    const tempAuthors = $(".issue-item__authors").text()
                    let authors = tempAuthors.charAt(0)
                    for (let i = 1; i < tempAuthors.length; i++) {
                        if (tempAuthors.charAt(i).toUpperCase() === tempAuthors.charAt(i) && tempAuthors.charAt(i - 1) !== ' ' && tempAuthors.charAt(i) !== ' ' && tempAuthors.charAt(i - 1).toUpperCase() !== tempAuthors.charAt(i - 1)) {
                            authors += ', '
                        } 
                        authors += tempAuthors.charAt(i)
                    }
        
                    const publishYear = $(".issue-item__header").text().slice(-4)

                    let keywords = ''
                    let ctr = 1
                    while (jq(`section[property='keywords'] > ol > li:nth-child(${ctr})`).text() !== '') {
                        keywords += jq(`section[property='keywords'] > ol > li:nth-child(${ctr++})`).text() + ' '
                    }
                    
                    let citedCount = 0
                    try {
                        citedCount = parseInt(jq(".citing-articles > :nth-child(2)").text().substring(jq(".citing-articles > :nth-child(2)").text().indexOf(':') + 2))
                    } catch (error) {
                        citedCount = parseInt(jq(".citing-articles > :nth-child(2)").text().substring(jq(".citing-articles > :nth-child(2)").text().indexOf(':') + 2, jq(".citing-articles > :nth-child(2)").text().indexOf(' ', jq(".citing-articles > :nth-child(2)").text().indexOf(':') + 2)))
                    }
                    citedCount += parseInt(jq(".citing-articles > :nth-child(3)").text().substring(jq(".citing-articles > :nth-child(3)").text().indexOf(':') + 2))
        
                    let fullText = ''
                    ctr = 1
                    while (jq(`section#sec-${ctr}`).text() !== '') {
                        fullText += jq(`section#sec-${ctr++}`).text() + ' '
                    }
    
                    fullText = fullText.replaceAll('\n', ' ')
                    fullText = fullText.replaceAll('\t', ' ')
                    fullText = fullText.replaceAll(',', ' ')
                    fullText = fullText.replaceAll('Introduction', '')
                    fullText = fullText.replaceAll('.', ' ')
                    fullText = fullText.replaceAll(':', '')
                    fullText = fullText.replaceAll('(', '')
                    fullText = fullText.replaceAll(')', '')
                    fullText = fullText.replaceAll("'", '')
                    fullText = fullText.replace(/\s\s+/g, ' ')

                    const abstract = jq("#abstract > div").text()
                    const spl = abstract.split('.')
                    let content = ''
                    ctr = 0
                    for (let i = 0; i < spl.length && ctr < 2; i++) {
                        if(spl[i].toLowerCase().includes(crawlInfo.simpleKeyword.toLowerCase())) {
                            ctr++ 
                            content += '...' + spl[i]
                        }
                    }
                    if (ctr == 0) {
                        try {
                            content = (spl[0] + '. ' + spl[1] + '. ' + spl[2])
                        } catch (error) {
                            content = spl[0] + '. '
                        }
                    }
                    content += '...'
                    
                    if (abstract.length > 0 && fullText.length > 0) {
                        crawlInfo.search_res_links.push({
                            index: i + ((crawlInfo.pageNum) * 100),
                            g_id: $("a.sage-search-title").attr("id"),
                            title: $(".issue-item__heading").text(),
                            abstract: abstract,
                            keywords: keywords,
                            full_text: fullText,
                            references_count: jq("div[role='doc-biblioentry listitem']").length,
                            content: content,
                            cited_count: citedCount,
                            authors: authors,
                            publisher: 'SAGE Journals',
                            publish_year: publishYear,
                            site: 'journals.sagepub.com',
                            free: true,
                            link: jq(".doi").text(),
                            pdf: pageURL.substring(0, pageURL.indexOf('/', 10)) + jq("a:contains('PDF')").attr("href"),
                            value: 0
                        })
                    }
                } catch (error) {
                    console.log("error obtaining journal info i-" + (i + 1))
                    console.log(error)
                }
            }    
            
            // next page
            crawlInfo.pageNum++
        }catch (e) {
            console.log("error load html page : " + e)
            console.log("reseting page : " + crawlInfo.pageNum)
            crawlInfo.attempt++
        }
    }

    return crawlInfo.search_res_links
}

// scd crawler setup
const POSSIBLE_FULL_TEXT_REMOVAL = [
    'authorship',
    'Authorship',
    'Author contributions',
    'CRediT authorship'
]
const MAX_PAGE_SCD = 3 // per page 100
let MAX_CRAWL_DATA_SCD = 40

// target 'https://www.sciencedirect.com'
async function scienceDirectCrawl(page, keyword, crawlInfo) {
    while (crawlInfo.pageNum < MAX_PAGE_SCD && crawlInfo.attempt < MAX_RESET) {
        console.log("Page num : " + crawlInfo.pageNum)
        
        await Promise.all([
            page.waitForNavigation(),
            page.goto(`https://www.sciencedirect.com/search?qs=${keyword}&date=${crawlInfo.date}&accessTypes=openaccess&show=100&offset=${((crawlInfo.pageNum * 100) - 100)}`, {
                waitUntil: 'domcontentloaded'
            }),
        ])
    
        try {
            await page.waitForSelector('ol.search-result-wrapper > li', {
                timeout: 5000
            })
        } catch (e) {
            // empty search
            return crawlInfo.search_res_links
        }
    
        const pageURL = page.url()
    
        let searchResRaw = ''
        try{
            searchResRaw = await page.$$eval("ol.search-result-wrapper > li", (results) => {
                const temp = []
                for (let i = 0; i < results.length; i++) {
                    // dapatin html
                    temp.push(results[i].innerHTML + "")
                }
                return temp
            })

            for (let i = 0; i < searchResRaw.length; i++) {
                if (crawlInfo.search_res_links.length === MAX_CRAWL_DATA_SCD) {
                    return crawlInfo.search_res_links
                }
                const $ = await cheerio.load(searchResRaw[i] + "")
        
                // prevent yang bukan journal
                if (!$('.login-message-container').text().includes('personalized search experience')) {
                    const detailJournalPath = $("a.result-list-title-link").attr("href")
                    console.log(detailJournalPath)
            
                    // obtaining journal info detail
                    try {
                        // masuk ke detail journal
                        await Promise.all([
                            page.waitForNavigation(),
                            page.goto(pageURL.substring(0, pageURL.indexOf('/', 10)) + detailJournalPath, {
                                timeout: 5000,
                                waitUntil: 'domcontentloaded'
                            }), page.waitForSelector('.Body > div > section', {
                                timeout: 3000
                            })
                        ])
            
                        const body = await page.$eval(`.Article`, (result) => {
                            return result.innerHTML
                        })
                        
                        const jq = await cheerio.load(body + "")

                        const tempAuthors = $(".Authors").text()
                        let authors = tempAuthors.charAt(0)
                        for (let i = 1; i < tempAuthors.length; i++) {
                            if (tempAuthors.charAt(i).toUpperCase() === tempAuthors.charAt(i) && tempAuthors.charAt(i - 1) !== ' ' && tempAuthors.charAt(i) !== ' ' && tempAuthors.charAt(i - 1).toUpperCase() !== tempAuthors.charAt(i - 1)) {
                                authors += ', '
                            } 
                            authors += tempAuthors.charAt(i)
                        }
            
                        const publishYear = $(".srctitle-date-fields").text().slice(-4)
        
                        const tempKey = jq(".keywords-section").text()
                        
                        let keywords = tempKey.charAt(0)
                        for (let i = 1; i < tempKey.length; i++) {
                            if (tempKey.charAt(i).toUpperCase() === tempKey.charAt(i) && tempKey.charAt(i - 1) !== ' ' && tempKey.charAt(i - 1).toUpperCase() !== tempKey.charAt(i - 1)) {
                                keywords += ' '
                            } 
                            keywords += tempKey.charAt(i)
                        }
                        keywords = keywords.replaceAll('Keywords', '')
                        keywords = keywords.replaceAll('(', '')
                        keywords = keywords.replaceAll(')', '')
                        keywords = keywords.replaceAll("'", '')
                        keywords = keywords.replace(/\s\s+/g, ' ')
                        
                        const citedCount = jq("#citing-articles-header").text().substring(jq("#citing-articles-header").text().indexOf('(') + 1, jq("#citing-articles-header").text().indexOf(')'))
            
                        let fullText = jq("#body > div").text()
                        let ctr = -1
                        for (let i = 0; i < POSSIBLE_FULL_TEXT_REMOVAL.length; i++) {
                            ctr = fullText.indexOf(POSSIBLE_FULL_TEXT_REMOVAL[i] + '')
                            if(ctr != -1) {
                                break
                            }
                        }
                        if(ctr > 0) {
                            fullText.length = ctr
                        }
        
                        fullText = fullText.replaceAll('\n', ' ')
                        fullText = fullText.replaceAll('\t', ' ')
                        fullText = fullText.replaceAll(',', ' ')
                        fullText = fullText.replaceAll('1. Introduction', '')
                        fullText = fullText.replaceAll('.', ' ')
                        fullText = fullText.replaceAll(':', '')
                        fullText = fullText.replaceAll('(', '')
                        fullText = fullText.replaceAll(')', '')
                        fullText = fullText.replaceAll("'", '')
                        fullText = fullText.replace(/\s\s+/g, ' ')
    
                        const abstract = jq(".abstract.author > div > p").text()
                        const spl = abstract.split('.')
                        let content = ''
                        ctr = 0
                        for (let i = 0; i < spl.length && ctr < 2; i++) {
                            if(spl[i].toLowerCase().includes(crawlInfo.simpleKeyword.toLowerCase())) {
                                ctr++ 
                                content += '...' + spl[i]
                            }
                        }
                        if (ctr == 0) {
                            try {
                                content = (spl[0] + '. ' + spl[1] + '. ' + spl[2])
                            } catch (error) {
                                content = spl[0] + '. '
                            }
                        }
                        content += '...'
                        
                        if (abstract.length > 0 && fullText.length > 0) {
                            crawlInfo.search_res_links.push({
                                index: i + ((crawlInfo.pageNum * 100) - 100),
                                g_id: detailJournalPath.slice(-17),
                                title: jq(".title-text").text(),
                                abstract: abstract,
                                keywords: keywords,
                                full_text: fullText,
                                references_count: jq(".reference").length,
                                content: content,
                                cited_count: citedCount,
                                authors: authors,
                                publisher: 'Elsevier',
                                publish_year: publishYear,
                                site: 'Elsevier',
                                free: true,
                                link: jq(".doi").text(),
                                pdf: pageURL.substring(0, pageURL.indexOf('/', 10)) + jq("a:contains('PDF')").attr("href"),
                                value: 0
                            })
                        }
                    } catch (error) {
                        console.log("error obtaining journal info i-" + (i + 1))
                        console.log(error)
                    }
                }
            }
            
            // next page
            crawlInfo.pageNum++
        }catch (e) {
            console.log("error load html page : " + e)
            console.log("reseting page : " + crawlInfo.pageNum)
            crawlInfo.attempt++
        }
    }

    return crawlInfo.search_res_links
}

// ieee crawler setup
const MAX_PAGE_IEEE = 10 // per page 10
let MAX_CRAWL_DATA_IEEE = 25

// target 'https://ieeexplore.ieee.org'
async function ieeeCrawl(page, keyword, crawlInfo) {
    while (crawlInfo.pageNum < MAX_PAGE_IEEE && crawlInfo.attempt < MAX_RESET) {
        console.log("Page num : " + crawlInfo.pageNum)

        await Promise.all([
            page.waitForNavigation(),
            page.goto(`https://ieeexplore.ieee.org/search/searchresult.jsp?queryText=${keyword}&highlight=true&returnType=SEARCH&matchPubs=true&rowsPerPage=10&pageNumber=${crawlInfo.pageNum}&openAccess=true&refinements=ContentType:Journals${crawlInfo.date}&returnFacets=ALL`, {
                waitUntil: 'domcontentloaded',
                timeout: 20000
            }),
        ])

        try {
            await page.waitForSelector('.List-results-items', {
                timeout: 5000
            })
        } catch (e) {
            // empty search
            return crawlInfo.search_res_links
        }

        const pageURL = page.url()

        let searchResRaw = ''
        try{
            searchResRaw = await page.$$eval(".List-results-items", (results) => {
                const temp = []
                for (let i = 0; i < results.length; i++) {
                    // dapatin html
                    temp.push(results[i].innerHTML + "")
                }
                return temp
            })

            for (let i = 0; i < searchResRaw.length; i++) {
                if (crawlInfo.search_res_links.length === MAX_CRAWL_DATA_IEEE) {
                    return crawlInfo.search_res_links
                }
                const $ = await cheerio.load(searchResRaw[i] + "")
    
                const detailJournalPath = $("a:contains('HTML')").attr("href")
                console.log(detailJournalPath)
    
                if(detailJournalPath !== undefined) {
                    try {
                        // masuk ke detail journal
                        await Promise.all([
                            page.waitForNavigation(),
                            page.goto(pageURL.substring(0, pageURL.indexOf('/', 10)) + detailJournalPath + 'references#references', {
                                timeout: 10000,
                                waitUntil: 'domcontentloaded'
                            }),
                            page.waitForSelector('.document-main', {
                                timeout: 10000
                            }),
                        ])
    
                        let body = await page.$eval(`.document-main`, (result) => {
                            return result.innerHTML
                        })
                        
                        let jq = await cheerio.load(body + "")
    
                        const referenceCount = Math.ceil(jq("div.reference-container").length / 2)
    
                        await page.click("#keywords-header", {clickCount:1})
            
                        body = await page.$eval(`.document-main`, (result) => {
                            return result.innerHTML
                        })
                        
                        jq = await cheerio.load(body + "")
    
                        let keywords = jq("li:contains('Author')").text()
                        if (keywords.length === 0) {
                            keywords = jq(".doc-keywords-list-item").text()
                        }
                        keywords = keywords.replaceAll('Author', '')
                        keywords = keywords.replaceAll('IEEE', '')
                        keywords = keywords.replaceAll('Keywords', '')
                        keywords = keywords.replaceAll(',', ' ')
                        keywords = keywords.replaceAll("'", '')
                        keywords = keywords.replace(/\s\s+/g, ' ')
    
                        const id = detailJournalPath.substring(10, 17)
    
                        let abstract = jq(".abstract-text.row").text()
                        abstract = abstract.replaceAll('Abstract', '')
                        abstract = abstract.replaceAll(':', '')
                        abstract = abstract.replaceAll('\n', '')
                        abstract = abstract.replaceAll('(', '')
                        abstract = abstract.replaceAll(')', '')
                        abstract = abstract.replaceAll("'", '')
    
                        const spl = abstract.split('.')
                        let content = ''
                        let ctr = 0
                        for (let i = 0; i < spl.length && ctr < 2; i++) {
                            if(spl[i].toLowerCase().includes(crawlInfo.simpleKeyword.toLowerCase())) {
                                ctr++ 
                                content += '...' + spl[i]
                            }
                        }
                        if (ctr == 0) {
                            try {
                                content = (spl[0] + '. ' + spl[1] + '. ' + spl[2])
                            } catch (error) {
                                content = spl[0] + '. '
                            }
                        }
                        content += '...'
    
                        let authors = $('p.author').text()
                        authors = authors.replaceAll(';', ', ')
    
                        let fullText = ""
                        for (let i = 0; i < 20; i++) {
                            fullText += jq("#article > #sec" + (i + 1)).text()
                        }
                        fullText = fullText.replaceAll('\n', ' ')
                        fullText = fullText.replaceAll('\t', '')
                        fullText = fullText.replace(/section/gi, '')
                        fullText = fullText.replaceAll('.', ' ')
                        fullText = fullText.replaceAll(',', ' ')
                        fullText = fullText.replaceAll(';', ' ')
                        fullText = fullText.replaceAll('(', '')
                        fullText = fullText.replaceAll(')', '')
                        fullText = fullText.replaceAll("'", '')
                        fullText = fullText.replace(/\s\s+/g, ' ')
    
                        let publishYear = jq(".doc-abstract-pubdate").text().slice(-5)
                        publishYear = publishYear.replaceAll(' ', '')
                        
                        if (abstract.length > 0 && fullText.length > 0) {
                            crawlInfo.search_res_links.push({
                                index: i + ((crawlInfo.pageNum * 10) - 10),
                                g_id: id,
                                title: jq(".document-title").text(),
                                abstract: abstract,
                                keywords: keywords,
                                full_text: fullText,
                                references_count: referenceCount,
                                content: content,
                                cited_count: jq(".document-banner-metric-count").first().text(),
                                authors: authors,
                                publisher: 'IEEE',
                                publish_year: publishYear,
                                site: 'ieeexplore.ieee.org',
                                free: true,
                                link: jq(".stats-document-abstract-doi > a").attr("href"),
                                pdf: pageURL.substring(0, pageURL.indexOf('/', 10)) + jq("a:contains('PDF')").attr("href"),
                                value: 0
                            })
                        }
                    } catch (e) {
                        console.log('error load detail : ' + (i + 1))
                        console.log(e)
                    }
                }
            }
            
            // next page
            crawlInfo.pageNum++
        } catch (e) {
            console.log("error load html page : " + e)
            console.log("reseting page : " + crawlInfo.pageNum)
            crawlInfo.attempt++
        }
    }

    return crawlInfo.search_res_links
}

// ACD crawler setup
const MAX_PAGE_ACD = 10 // per page 20
let MAX_CRAWL_DATA_ACD = 25

// target 'https://academic.oup.com'
async function academicCrawl(page, keyword, crawlInfo) {
    while (crawlInfo.pageNum < MAX_PAGE_ACD && crawlInfo.attempt < MAX_RESET) {
        console.log("Page num : " + crawlInfo.pageNum)

        await Promise.all([
            page.waitForNavigation(),
            page.goto(`https://academic.oup.com/journals/search-results?${keyword}&allJournals=1&f_ContentType=Journal+Article&fl_SiteID=5567&access_openaccess=true&page=${crawlInfo.pageNum}&${crawlInfo.date}`, {
                waitUntil: 'domcontentloaded'
            }),
            sleep(300)
        ])

        try{
            // recaptcha resolver
            const recaptcha = await page.$eval(`body`, (result) => {
                return result.innerHTML
            })
            const dol = await cheerio.load(recaptcha + "")
            
            if (dol('.explanation-message').text().length === 0) {
                const pageURL = page.url()

                let searchResRaw = ''
                searchResRaw = await page.$$eval(".sr-list.al-article-box", (results) => {
                    const temp = []
                    for (let i = 0; i < results.length; i++) {
                        // dapatin html
                        temp.push(results[i].innerHTML + "")
                    }
                    return temp
                })
                
                if (searchResRaw.length === 0) {
                    // empty search
                    return crawlInfo.search_res_links
                }

                for (let i = 0; i < searchResRaw.length; i++) {
                    if (crawlInfo.search_res_links.length === MAX_CRAWL_DATA_ACD) {
                        return crawlInfo.search_res_links
                    }
                    const $ = await cheerio.load(searchResRaw[i] + "")
            
                    const detailJournalPath = $(".article-link").attr("href")
                    console.log(detailJournalPath)
            
                    if(detailJournalPath) {
                        try {
                            // masuk ke detail journal
                            await Promise.all([
                                page.waitForNavigation(),
                                page.goto(pageURL.substring(0, pageURL.indexOf('/', 10)) + detailJournalPath, {
                                    waitUntil: 'domcontentloaded'
                                }),
                                page.waitForSelector('.content-main', {
                                    timeout: 10000
                                }),
                            ])
                
                            const body = await page.$eval(`.content-main`, (result) => {
                                return result.innerHTML
                            })
                            
                            const jq = await cheerio.load(body + "")
            
                            if (jq(".pdf-notice").text().length === 0) {
                                let title = jq(".wi-article-title").text()
                                title = title.replaceAll('\n', '')
                                title = title.replace(/\s\s+/g, ' ')
                                title = title.substring(1)
                
                                let abstract = jq(".abstract").text()
                                abstract = abstract.replaceAll('\n', '')
                                abstract = abstract.replaceAll('.', ' ')
                                abstract = abstract.replaceAll(',', ' ')
                                abstract = abstract.replaceAll(';', ' ')
                                abstract = abstract.replaceAll('(', '')
                                abstract = abstract.replaceAll(')', '')
                                abstract = abstract.replaceAll("'", '')
                                abstract = abstract.replace(/\s\s+/g, ' ')
                
                                let fullText = ""
                                jq(".chapter-para").map((i, card) => {
                                    if (!abstract.includes($(card).text())) {
                                        fullText += $(card).text() + ' '
                                    }
                                })
                                fullText = fullText.replaceAll('\n', '')
                                fullText = fullText.replaceAll('.', ' ')
                                fullText = fullText.replaceAll(',', ' ')
                                fullText = fullText.replaceAll(';', ' ')
                                fullText = fullText.replaceAll('(', '')
                                fullText = fullText.replaceAll(')', '')
                                fullText = fullText.replaceAll("'", '')
                                fullText = fullText.replace(/\s\s+/g, ' ')
                
                                let keywords = jq(".kwd-group").text()
                                keywords = keywords.replaceAll(',', '')
                
                                let content = $('.snippet').text()
                                content = content.replaceAll('\n', ' ')
                                content = content.replaceAll("'", '')
                                content = content.replace(/\s\s+/g, ' ')
            
                                let citedCount = 0
                                if (jq(".__db_score_normal").text().length > 0) {
                                    citedCount = jq(".__db_score_normal").text()
                                }
                                
                                if (abstract.length > 0 && fullText.length > 0) {
                                    crawlInfo.search_res_links.push({
                                        index: i + ((crawlInfo.pageNum * 20) - 20),
                                        g_id: jq("a:contains('https://doi.org')").attr("href").substring(24),
                                        title: title,
                                        abstract: abstract,
                                        keywords: keywords,
                                        full_text: fullText,
                                        references_count: jq(".js-splitview-ref-item").length,
                                        content: content,
                                        cited_count: citedCount,
                                        authors: $('.sri-authors').text(),
                                        publisher: 'Oxford Academic',
                                        publish_year: $(".sri-date").text().slice(-4),
                                        site: 'academic.oup.com',
                                        free: true,
                                        link: jq("a:contains('https://doi.org')").attr("href"),
                                        pdf: pageURL.substring(0, pageURL.indexOf('/', 10)) + jq(".pdf").attr("href"),
                                        value: 0
                                    })
                                }
                            }
                        }catch (e) {
                            console.log('error load detail : ' + (i + 1))
                            console.log(e)
                        }
                    }
                }

                // next page
                crawlInfo.pageNum++
            } else {
                // reset from recaptcha
                crawlInfo.attempt++
            }
        }catch (e) {
            console.log("error load html page : " + e)
            console.log("reseting page : " + crawlInfo.pageNum)
            crawlInfo.attempt++
        }
    }
    
    return crawlInfo.search_res_links
}


// CRAWLER HELPER
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}



// Normalized Term Frequency and Inverse Document Frequency (IDF), mode 1 : abstract, 2 keywords
function cosineSimilarity(docs, query, mode = 1) {
    const qWords = query.split(" ")
    let ALL_DOCS_TF = [] // Setiap kata dari setiap dokumen, bisa ada mengandung kata yang sama dari antar dokumen (tetapi doc id beda)
    let allWords = [] // isi semua kata dari semua dokumen (tidak ada yang sama)

    // normalisasi TF Semua document
    for (let i = 0; i < docs.length; i++) {
        let words = '-'
        if (mode == 1) {
            docs[i].abstract.toLowerCase()
            words = docs[i].abstract.split(" ")
        } else if (mode == 2) {
            docs[i].keywords.toLowerCase()
            words = docs[i].keywords.split(" ")
        } else if (mode == 3) {
            docs[i].full_text.toLowerCase()
            words = docs[i].full_text.split(" ")
        }
        const res = []

        // setiap kata di dalam doc, dihitung frekuensinya (ctr)
        for (let j = 0; j < words.length; j++) {
            let flag = true
            for (let k = 0; k < res.length; k++) {
                // apakah kata ini sudah pernah dipush
                if (words[j] == res[k].text){
                    // jika ya tambahin ctr
                    res[k].ctr++
                    flag = false
                    break
                }
            }

            if (flag) {
                // jika tidak (flag = true), push
                res.push({
                    originDocIdx: i,
                    text: words[j],
                    ctr: 1
                })
            }
        }

        for (let j = 0; j < res.length; j++) {
            // normalisasi
            res[j].tf = (res[j].ctr * 1.0 / words.length)

            // untuk dapatin semua kata dalam dokumen (yang berbeda semua)
            let flag = true
            for (let k = 0; k < allWords.length; k++) {
                if(res[j].text == allWords[k]) {
                    flag = false
                    break
                }
            }

            if (flag) {
                allWords.push(res[j].text)
            }

            ALL_DOCS_TF.push(res[j])
        }
    }

    // cari TF query
    const queryTF = []
    for (let j = 0; j < qWords.length; j++) {
        let flag = true
        for (let k = 0; k < queryTF.length; k++) {
            // apakah kata ini sudah pernah dipush
            if (qWords[j] == queryTF[k].text){
                // jika ya tambahin ctr
                queryTF[k].ctr++
                flag = false
                break
            }
        }

        if (flag) {
            // jika tidak (flag = true), push
            queryTF.push({
                text: qWords[j],
                ctr: 1
            })
        }
    }
    // normalisasi TF query
    for (let j = 0; j < queryTF.length; j++) {
        queryTF[j].tf = (queryTF[j].ctr * 1.0 / qWords.length)
    }


    // norm TF * IDF
    let docQueryTFxIDF = []
    for (let j = 0; j < queryTF.length; j++) {
        for (let i = 0; i < allWords.length; i++) {
            if(allWords[i] == queryTF[j].text) {
                let ctr = 0
                for (let k = 0; k < ALL_DOCS_TF.length; k++) {
                    if (ALL_DOCS_TF[k].text == allWords[i]) {
                        // hitung berapa banyak kata ini muncul di semua dokumen (setiap DOKUMEN pasti hanya mengandung 1 atau tidak sama sekali)
                        ctr++
                    }
                }

                // query IDF value
                queryTF[j].idf_val = 1.0 + Math.log(docs.length * 1.0 / ctr)

                // query normTF * IDF value
                queryTF[j].normTFxIDFval = queryTF[j].tf * queryTF[j].idf_val * 1.0

                // docQueryTFxIDF diisi dengan semua ALL_DOCS_TF yang text nya queryTF[j].text (ambil queryTF[j].text dari seluruh dokumen yang mengandung)
                for (let k = 0; k < ALL_DOCS_TF.length; k++) {
                    if(allWords[i] == ALL_DOCS_TF[k].text) {
                        // IDF value
                        ALL_DOCS_TF[k].idf_val = 1.0 + Math.log(docs.length * 1.0 / ctr)

                        // normTF * IDF
                        ALL_DOCS_TF[k].normTFxIDFval = ALL_DOCS_TF[k].tf * ALL_DOCS_TF[k].idf_val * 1.0
                        docQueryTFxIDF.push(ALL_DOCS_TF[k])
                    }
                }

                break
            }
        }
    }

    // calculate cosine similarity
    calcCosineSimilarity(docs, docQueryTFxIDF, queryTF, mode)
}

function calcCosineSimilarity (docs, docQueryTFxIDF, queryTF, mode) {
    // console.log(docQueryTFxIDF)
    // console.log("===========")
    // console.log(queryTF)
    let sqrtQuery = 0.0
    for (let i = 0; i < queryTF.length; i++) {
        if(queryTF[i].normTFxIDFval) {
            sqrtQuery += (queryTF[i].normTFxIDFval * queryTF[i].normTFxIDFval * 1.0)
        }
    }
    sqrtQuery = Math.sqrt(sqrtQuery)

    for (let i = 0; i < docs.length; i++) {
        let dotProduct = 0.0
        let sqrtDoc = 0.0

        for (let j = 0; j < docQueryTFxIDF.length; j++) {
            if(docQueryTFxIDF[j].originDocIdx == i && docQueryTFxIDF[j].normTFxIDFval) {
                sqrtDoc += (docQueryTFxIDF[j].normTFxIDFval * docQueryTFxIDF[j].normTFxIDFval * 1.0)

                for (let k = 0; k < queryTF.length; k++) {
                    if(docQueryTFxIDF[j].text == queryTF[k].text) {
                        dotProduct += (docQueryTFxIDF[j].normTFxIDFval * queryTF[k].normTFxIDFval * 1.0)
                        break
                    }
                }
            }
        }
        sqrtDoc = Math.sqrt(sqrtDoc)

        if (mode == 1) {
            docs[i].abstractCos = 0
            if (dotProduct != 0) {
                docs[i].abstractCos = (dotProduct / (sqrtDoc * sqrtQuery))
                if(docs[i].abstractCos > 1.0) {
                    docs[i].abstractCos = 1
                }
            }
        } else if (mode == 2 ) {
            docs[i].keywordsCos = 0
            if (dotProduct != 0) {
                docs[i].keywordsCos = (dotProduct / (sqrtDoc * sqrtQuery))
                if(docs[i].keywordsCos > 1.0) {
                    docs[i].keywordsCos = 1
                }
            }
        } else {
            docs[i].fullTextCos = 0
            if (dotProduct != 0) {
                docs[i].fullTextCos = (dotProduct / (sqrtDoc * sqrtQuery))
                if(docs[i].fullTextCos > 1.0) {
                    docs[i].fullTextCos = 1
                }
            }
        }
    }
}

const ALPHA = 0.1
const PENALTY_TRESHOLD = 0.7
// require cosine similarity first
function journalsEvaluation (docs, cosinusKeyword, simpleKeyword, sfKeyword, searchFactors, crawlerOpt) {
    // sentence similarity, secara literal dengan simpleKeyword
    let maxAbsSenSim = sentenceSimilarity(docs, simpleKeyword, 1)
    let maxKeySenSim = sentenceSimilarity(docs, simpleKeyword, 2)
    let maxFtSenSim = sentenceSimilarity(docs, simpleKeyword, 3)

    const abstracts = []
    const keywords = []
    const fullTexts = []
    let maxRef = 1
    let maxCited = 1
    for (let i = 0; i < docs.length; i++) {
        docs[i].factorSFAbs = 0
        docs[i].factorSFKey = 0
        docs[i].factorSFFt = 0
        abstracts.push(docs[i].abstract)
        keywords.push(docs[i].keywords)
        fullTexts.push(docs[i].full_text)

        if(docs[i].references_count > maxRef){
            maxRef = docs[i].references_count
        }

        if(parseInt(docs[i].cited_count) > maxCited){
            maxCited = parseInt(docs[i].cited_count)
        }
    }

    // cosine similarity dengan cosineKeyword, handmade first
    cosineSimilarity(docs, cosinusKeyword, 1)
    cosineSimilarity(docs, cosinusKeyword, 2)
    cosineSimilarity(docs, cosinusKeyword, 3)

    // cosinus similarity npm dengan cosinusKeyword
    let tf_idf_abs = new TfIdf()
    let tf_idf_key = new TfIdf()
    let tf_idf_ft = new TfIdf()
    tf_idf_abs.createCorpusFromStringArray(abstracts)
    tf_idf_key.createCorpusFromStringArray(keywords)
    tf_idf_ft.createCorpusFromStringArray(fullTexts)

    let search_result = tf_idf_abs.rankDocumentsByQuery(cosinusKeyword)
    for (let i = 0; i < search_result.length; i++) {
        docs[search_result[i].index].factorSenSimAbs = (docs[search_result[i].index].abstractSenSim / maxAbsSenSim)
        docs[search_result[i].index].abstractVal = (search_result[i].similarityIndex + docs[search_result[i].index].abstractCos) * 0.5
    }

    search_result = tf_idf_key.rankDocumentsByQuery(cosinusKeyword)
    for (let i = 0; i < search_result.length; i++) {
        docs[search_result[i].index].factorSenSimKey = (docs[search_result[i].index].keywordsSenSim / maxKeySenSim)
        docs[search_result[i].index].keywordsVal = (search_result[i].similarityIndex + docs[search_result[i].index].keywordsCos) * 0.5 
    }

    search_result = tf_idf_ft.rankDocumentsByQuery(cosinusKeyword)
    for (let i = 0; i < search_result.length; i++) {
        docs[search_result[i].index].factorSenSimFT = (docs[search_result[i].index].fullTextSenSim / maxFtSenSim)
        docs[search_result[i].index].fullTextVal = (search_result[i].similarityIndex + docs[search_result[i].index].fullTextCos) * 0.5
    }

    // cosine similarity sfKeyword
    if (sfKeyword.length > 0) { 
        // sf literal
        maxAbsSenSim = 0
        maxKeySenSim = 0
        maxFtSenSim = 0
        for (let i = 0; i < searchFactors.length; i++) {
            maxAbsSenSim = sentenceSimilarity(docs, searchFactors[i].sub_factor, 1)
            maxKeySenSim = sentenceSimilarity(docs, searchFactors[i].sub_factor, 2)
            maxFtSenSim = sentenceSimilarity(docs, searchFactors[i].sub_factor, 3) 
            for (let j = 0; j < docs.length; j++) {
                docs[j].factorSFAbs += (docs[j].abstractSenSim / maxAbsSenSim)
                docs[j].factorSFKey += (docs[j].keywordsSenSim / maxKeySenSim)
                docs[j].factorSFFt += (docs[j].fullTextSenSim / maxFtSenSim)
            }
        }
        // sensim dengan search factors 60%
        for (let j = 0; j < docs.length; j++) {
            docs[j].factorSFAbs = (docs[j].factorSFAbs / searchFactors.length) * 0.6
            docs[j].factorSFKey = (docs[j].factorSFKey / searchFactors.length) * 0.6
            docs[j].factorSFFt = (docs[j].factorSFFt / searchFactors.length) * 0.6
        }

        // buat ngeboost value karena word sim sifatnya match bukan == (cosine sim)
        const maxAbsWordSim = wordSimilarity(docs, sfKeyword, 1)
        const maxKeyWordSim = wordSimilarity(docs, sfKeyword, 2)
        const maxFtWordSim = wordSimilarity(docs, sfKeyword, 3)
    
        // cosinus similarity npm dengan sfKeyword bagiannya 0.4 / 40%
        // kemudian ditambah 0.1 * word sim value
        search_result = tf_idf_abs.rankDocumentsByQuery(sfKeyword)
        for (let i = 0; i < search_result.length; i++) {
            docs[search_result[i].index].factorSFAbs += ((search_result[i].similarityIndex) * 0.4)
            docs[search_result[i].index].factorSFAbs += (ALPHA * docs[search_result[i].index].factorSFAbs * (docs[search_result[i].index].abstractWordSim / maxAbsWordSim))
            if (docs[search_result[i].index].factorSFAbs > 1) {
                docs[search_result[i].index].factorSFAbs = 1
            }
        }
    
        search_result = tf_idf_key.rankDocumentsByQuery(sfKeyword)
        for (let i = 0; i < search_result.length; i++) {
            docs[search_result[i].index].factorSFKey += ((search_result[i].similarityIndex) * 0.4)
            docs[search_result[i].index].factorSFKey += (ALPHA * docs[search_result[i].index].factorSFKey * (docs[search_result[i].index].keywordsWordSim / maxKeyWordSim))
            if (docs[search_result[i].index].factorSFKey > 1) {
                docs[search_result[i].index].factorSFKey = 1
            }
        }

        search_result = tf_idf_ft.rankDocumentsByQuery(sfKeyword)
        for (let i = 0; i < search_result.length; i++) {
            docs[search_result[i].index].factorSFFt += ((search_result[i].similarityIndex) * 0.4)
            docs[search_result[i].index].factorSFFt += (ALPHA * docs[search_result[i].index].factorSFFt * (docs[search_result[i].index].fullTextWordSim / maxFtWordSim))
            if (docs[search_result[i].index].factorSFFt > 1) {
                docs[search_result[i].index].factorSFFt = 1
            }
        }   
    }

    // cited count and reference count value, and factor 
    let maxFactorSenSim = 0
    let maxFactorSF = 0
    for (let i = 0; i < docs.length; i++) {
        docs[i].citedVal = parseInt(docs[i].cited_count) / maxCited 
        docs[i].referencesVal = docs[i].references_count / maxRef 

        if (crawlerOpt > 0) {
            docs[i].factorSenSim = (docs[i].factorSenSimAbs
                                    + docs[i].factorSenSimKey 
                                    + docs[i].factorSenSimFT) * 1.0 / 3.0
    
            docs[i].factorSF = 0
            if (sfKeyword.length > 0) {
                docs[i].factorSF = (docs[i].factorSFAbs
                                    + docs[i].factorSFKey 
                                    + docs[i].factorSFFt) * 1.0 / 3.0
            }
        } else {
            docs[i].factorSenSim = (docs[i].factorSenSimAbs + docs[i].factorSenSimKey) * 1.0 / 2.0
    
            docs[i].factorSF = 0
            if (sfKeyword.length > 0) {
                docs[i].factorSF = (docs[i].factorSFAbs + docs[i].factorSFKey) * 1.0 / 2.0
            }
        }

        // mencari max factor sensim dan sf untuk normalisasi
        if(docs[i].factorSenSim > maxFactorSenSim){
            maxFactorSenSim = docs[i].factorSenSim
        }
        if(docs[i].factorSF > maxFactorSF){
            maxFactorSF = docs[i].factorSF
        }

        docs[i].factor = (docs[i].factorSenSim * 0.4) + (docs[i].factorSF * 0.6)
    }

    // penalty for journal that have diff factorSenSim with factorSF more than treshold
    for (let i = 0; i < docs.length; i++) {
        // jika diff melebihi treshold maka factor akan menjadi 1 - (diff - treshold) bagian dari factor awal nya saja
        if(Math.abs((docs[i].factorSenSim / maxFactorSenSim) - (docs[i].factorSF / maxFactorSF)) >= PENALTY_TRESHOLD) {
            docs[i].factor *= (1 - (Math.abs((docs[i].factorSenSim / maxFactorSenSim) - (docs[i].factorSF / maxFactorSF)) - PENALTY_TRESHOLD))
        }
    }

    // jadi untuk abtractVal, keywordsVal, dan FullTextVal 
    // semuanya melewati process cosine similarity handmade dengan keyword + sf
    // baru cosine similarity npm lagi dengan keyword + sf 
    // kemudian val = (npm + handmade) / 2 
    // kemudian dicari factor = factorSenSim (40%) + factorSF (60%)
    // factorSF berasal dari (60% sensim dengan literal search factors, karena ada sf yang lebih dari 1 kata cth machine learning) + (40% npm cosine sim dengan sfkeyword + 0.1 * wordsim dengan sfkeyword)
    // factorSF -> untuk mencegah journal yang tidak sesuai dengan background (search factor) pencarian user 
    // factorSenSim -> untuk mencegah journal yang tidak mengandung keyword secara literal (genetic algorithm bukan genetic human hair, atau best algorithm)
    // factor akan memengaruhi fitness value, semakin mendekati 1 (max) maka journal = semakin relevant
}

// query -> simpleKeyword, mode 1 = abstract, 2 = keywords, 3 = fulltext
// return max senSim dan senSim untuk setiap DOKUMEN sesuai dengan mode
function sentenceSimilarity (docs, query, mode) { 
    // build newQuery for regExp creation
    let newQuery = query.charAt(0)
    for (let i = 1; i < query.length; i++) {
        if(query.charAt(i) === ' ') {
            newQuery += '\\s'
        } else {
            newQuery += query.charAt(i)
        }
    }
    newQuery = new RegExp(newQuery, 'gi')

    let max = 1
    for (let i = 0; i < docs.length; i++) {
        if (mode === 1) {
            docs[i].abstractSenSim = docs[i].abstract.match(newQuery)
            if (docs[i].abstractSenSim) {
                docs[i].abstractSenSim = docs[i].abstractSenSim.length + 1
                if(docs[i].abstractSenSim > max) {
                    max = docs[i].abstractSenSim
                }
            } else {
                docs[i].abstractSenSim = 1
            }
        } else if (mode === 2) {
            docs[i].keywordsSenSim = docs[i].keywords.match(newQuery)
            if (docs[i].keywordsSenSim) {
                docs[i].keywordsSenSim = docs[i].keywordsSenSim.length + 1
                if(docs[i].keywordsSenSim > max) {
                    max = docs[i].keywordsSenSim
                }
            } else {
                docs[i].keywordsSenSim = 1
            }
        } else {
            docs[i].fullTextSenSim = docs[i].full_text.match(newQuery)
            if (docs[i].fullTextSenSim) {
                docs[i].fullTextSenSim = docs[i].fullTextSenSim.length + 1
                if(docs[i].fullTextSenSim > max) {
                    max = docs[i].fullTextSenSim
                }
            } else {
                docs[i].fullTextSenSim = 1
            }
        }
    }

    return max
}

// query -> sfKeyword, mode 1 = abstract, 2 = keywords, 3 = fulltext
function wordSimilarity (docs, query, mode) { 
    // build newQuery for regExp creation
    let words = query.split(' ')
    let newQuery = []
    for (let i = 0; i < words.length; i++) {
        newQuery.push(new RegExp(words[i], 'gi'))
    }

    let max = newQuery.length
    for (let i = 0; i < docs.length; i++) {
        if (mode === 1) {
            docs[i].abstractWordSim = 0
        } else if (mode === 2) {
            docs[i].keywordsWordSim = 0
        } else {
            docs[i].fullTextWordSim = 0
        }

        for (let j = 0; j < newQuery.length; j++) {
            if (mode === 1) {
                const temp = docs[i].abstract.match(newQuery[j])
                if (temp) {
                    docs[i].abstractWordSim += (temp.length + 1)
                } else {
                    docs[i].abstractWordSim++
                }

                if(docs[i].abstractWordSim > max) {
                    max = docs[i].abstractWordSim
                }
            } else if (mode === 2) {
                const temp = docs[i].keywords.match(newQuery[j])
                if (temp) {
                    docs[i].keywordsWordSim += (temp.length + 1)
                } else {
                    docs[i].keywordsWordSim++
                }

                if(docs[i].keywordsWordSim > max) {
                    max = docs[i].keywordsWordSim
                }
            } else {
                const temp = docs[i].full_text.match(newQuery[j])
                if (temp) {
                    docs[i].fullTextWordSim += (temp.length + 1)
                } else {
                    docs[i].fullTextWordSim++
                }
                
                if(docs[i].fullTextWordSim > max) {
                    max = docs[i].fullTextWordSim
                }
            }
        }
    }

    return max
}

module.exports = router