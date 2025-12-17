/**
 * Performance Monitoring Middleware
 * Tracks database query counts, response times, and cache performance
 */

const mongoose = require('mongoose');

// Track query counts per request
let queryCount = 0;
let queryTimes = [];

// Reset counters for each request
const resetCounters = () => {
  queryCount = 0;
  queryTimes = [];
};

// Monitor MongoDB queries
const originalExec = mongoose.Query.prototype.exec;
mongoose.Query.prototype.exec = function() {
  const startTime = Date.now();
  queryCount++;
  
  const result = originalExec.apply(this, arguments);
  
  if (result && typeof result.then === 'function') {
    return result.then((data) => {
      const duration = Date.now() - startTime;
      const modelName = (this.model && this.model.modelName) ? this.model.modelName : 'Unknown';
      const options = this.getOptions ? this.getOptions() : {};
      queryTimes.push({
        model: modelName,
        operation: this.op || 'unknown',
        duration,
        lean: options.lean || false
      });
      return data;
    }).catch((error) => {
      // Still track the query even if it fails
      const duration = Date.now() - startTime;
      queryTimes.push({
        model: 'Unknown',
        operation: 'error',
        duration,
        lean: false,
        error: true
      });
      throw error;
    });
  }
  
  return result;
};

/**
 * Performance monitoring middleware
 */
const performanceMonitor = (req, res, next) => {
  const startTime = Date.now();
  resetCounters();
  
  // Override res.json to capture response time
  const originalJson = res.json.bind(res);
  res.json = function(data) {
    const responseTime = Date.now() - startTime;
    const avgQueryTime = queryTimes.length > 0 
      ? queryTimes.reduce((sum, q) => sum + q.duration, 0) / queryTimes.length 
      : 0;
    
    // Log performance metrics (only in development)
    if (process.env.NODE_ENV !== 'production') {
      console.log(`📊 ${req.method} ${req.path}`);
      console.log(`   ⏱️  Response Time: ${responseTime}ms`);
      console.log(`   🔢 Query Count: ${queryCount}`);
      console.log(`   ⚡ Avg Query Time: ${avgQueryTime.toFixed(2)}ms`);
      console.log(`   📈 Total Query Time: ${queryTimes.reduce((sum, q) => sum + q.duration, 0)}ms`);
      
      if (queryTimes.length > 0) {
        const leanQueries = queryTimes.filter(q => q.lean).length;
        const regularQueries = queryTimes.length - leanQueries;
        console.log(`   ✅ Lean Queries: ${leanQueries} | Regular: ${regularQueries}`);
      }
    }
    
    // Add performance headers
    res.set('X-Response-Time', `${responseTime}ms`);
    res.set('X-Query-Count', queryCount.toString());
    res.set('X-Avg-Query-Time', `${avgQueryTime.toFixed(2)}ms`);
    
    return originalJson(data);
  };
  
  next();
};

/**
 * Get performance statistics
 */
const getPerformanceStats = () => {
  // Ensure queryTimes is always an array
  const safeQueryTimes = Array.isArray(queryTimes) ? queryTimes : [];
  
  return {
    queryCount: queryCount || 0,
    queryTimes: safeQueryTimes,
    totalQueryTime: safeQueryTimes.length > 0 
      ? safeQueryTimes.reduce((sum, q) => sum + (q.duration || 0), 0) 
      : 0,
    avgQueryTime: safeQueryTimes.length > 0 
      ? safeQueryTimes.reduce((sum, q) => sum + (q.duration || 0), 0) / safeQueryTimes.length 
      : 0,
    leanQueries: safeQueryTimes.filter(q => q.lean === true).length,
    regularQueries: safeQueryTimes.filter(q => q.lean !== true).length
  };
};

module.exports = {
  performanceMonitor,
  getPerformanceStats,
  resetCounters
};

