---
type: reference
title: "Alt Data"
description: "Satellite imagery: parking lot traffic → retail footfall → revenue proxy. News sentiment: NLP on headlines → TF-IDF → polarity score"
tags: ["data-engineering"]
timestamp: "2026-06-27T03:06:09.442Z"
phase: 12
phaseName: "Data Engineering"
category: "Phase 12 - Data Engineering"
subcategory: "data-engineering"
language: "cpp"
artifact-id: "ZHFT_ALT_DATA"
---
## Key Learning Points

- Satellite imagery: parking lot traffic → retail footfall → revenue proxy
- News sentiment: NLP on headlines → TF-IDF → polarity score
- Web scraping: price scraping, job postings, supply chain tracking
- Social media signals: Twitter volume spike, Reddit wallstreetbets
- Options flow: put/call ratio, trade/size ratio, block trades
- Data vendor evaluation: timeliness, coverage, accuracy, cost

## Usage

NewsSentimentParser nlp;
nlp.loadStopwords("stopwords.txt");
auto score = nlp.sentiment("Apple beats earnings estimates");

## Source Code

```cpp
#include <string>
#include <vector>
#include <unordered_map>
#include <cmath>
#include <sstream>

// --------------------------------------------------------------------
// TF-IDF News Sentiment Parser

class NewsSentimentParser {
    std::unordered_map<std::string, int> df_;     // document frequency
    std::unordered_map<std::string, bool> stopwords_;
    int total_docs_{0};

    // sentiment word lists
    // tradeoff: lexicon-based vs ML model (BERT) — speed vs accuracy
    const std::vector<std::string> positive_{"beat", "surge", "profit", "growth",
                                              "upgrade", "bullish", "outperform"};
    const std::vector<std::string> negative_{"miss", "plunge", "loss", "decline",
                                              "downgrade", "bearish", "underperform"};

public:
    void loadStopwords(const std::string& file) {
        // load common stopwords
        stopwords_["the"] = true; stopwords_["a"] = true;
        stopwords_["an"] = true; stopwords_["is"] = true;
        // ...
    }

    void addDocument(const std::string& text) {
        total_docs_++;
        std::unordered_map<std::string, bool> seen;
        std::istringstream iss(text);
        std::string word;
        while (iss >> word) {
            std::transform(word.begin(), word.end(), word.begin(), ::tolower);
            if (stopwords_.count(word)) continue;
            // strip punctuation
            word.erase(std::remove_if(word.begin(), word.end(), ::ispunct), word.end());
            if (word.empty()) continue;
            if (!seen[word]) { df_[word]++; seen[word] = true; }
        }
    }

    double tfidf(const std::string& term, const std::string& doc) {
        // TF = count of term in doc / total terms in doc
        // IDF = log(total_docs / df[term])
        int term_count = 0;
        int total_terms = 0;
        std::istringstream iss(doc);
        std::string word;
        while (iss >> word) {
            std::transform(word.begin(), word.end(), word.begin(), ::tolower);
            total_terms++;
            if (word == term) term_count++;
        }
        double tf = static_cast<double>(term_count) / std::max(total_terms, 1);
        double idf = std::log(static_cast<double>(total_docs_ + 1)
                              / (df_[term] + 1));
        return tf * idf;
    }

    // Sentiment score: [-1, 1] based on weighted keyword match
    double sentiment(const std::string& headline) {
        double score = 0;
        int matches = 0;
        std::string lower = headline;
        std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);

        for (auto& pos : positive_) {
            if (lower.find(pos) != std::string::npos) {
                double w = tfidf(pos, lower);  // rare words get higher weight
                score += w;
                matches++;
            }
        }
        for (auto& neg : negative_) {
            if (lower.find(neg) != std::string::npos) {
                double w = tfidf(neg, lower);
                score -= w;
                matches++;
            }
        }
        // tradeoff: raw weighted sum vs [-1,1] normalization
        // Normalization hides magnitude but enables cross-headline comparison
        return matches > 0 ? score / matches : 0;
    }
};

// --------------------------------------------------------------------
// Options Flow Analysis

class OptionsFlowAnalyzer {
    struct OptionTrade {
        std::string symbol;
        double strike;
        double expiry;         // days to expiry
        bool   is_call;
        double premium;
        uint32_t contract_qty; // each contract = 100 shares
        double trade_size;     // premium * contracts * 100
        bool   is_block;       // > 500 contracts
    };

    // Put/Call ratio: volume of puts / volume of calls
    // tradeoff: volume-weighted vs count-weighted
    struct PCRatio {
        double volume_ratio;
        double open_interest_ratio;
        double block_trade_ratio;  // institutional flow
    };

    PCRatio computeRatio(const std::vector<OptionTrade>& trades,
                         const std::vector<OptionTrade>& oi) {
        double put_vol = 0, call_vol = 0;
        double block_put = 0, block_call = 0;
        for (auto& t : trades) {
            if (t.is_call) call_vol += t.contract_qty;
            else put_vol += t.contract_qty;
            if (t.is_block) {
                if (t.is_call) block_call += t.contract_qty;
                else block_put += t.contract_qty;
            }
        }
        // High put/call ratio → bearish sentiment
        // tradeoff: PCR is lagging — combine with IV skew for leading signal
        return {
            put_vol / std::max(call_vol, 1.0),
            0.0,  // OI ratio
            block_put / std::max(block_call, 1.0)
        };
    }
};
```
