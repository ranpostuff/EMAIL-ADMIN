/* Shared presentation only. Data, callbacks, interactions and chart IDs stay intact. */
(() => {
    if (!window.Chart) return;
    const colors = { incidents: '#d18ba9', active: '#d88881', resolved: '#81b69a', violations: '#c9ab72', secondary: '#9babc5' };
    Chart.register({
        id: 'rescueProductTheme',
        beforeUpdate(chart) {
            const options = chart.config.options;
            options.animation = false;
            options.font = { family: 'Inter, system-ui, sans-serif', size: 12 };
            options.plugins ||= {};
            const tip = options.plugins.tooltip ||= {};
            Object.assign(tip, { backgroundColor:'#24212a', titleColor:'#f6f0f4', bodyColor:'#f6f0f4', footerColor:'#c5bbc6', borderColor:'#514654', borderWidth:1, cornerRadius:8, padding:12, titleFont:{size:12,weight:'600'}, bodyFont:{size:12}, displayColors:true, boxWidth:8, boxHeight:8 });
            const legend = options.plugins.legend ||= {};
            legend.position = 'bottom';
            legend.labels = { ...legend.labels, color:'#c5bbc6', padding:16, boxWidth:8, boxHeight:8, usePointStyle:true, pointStyle:'rectRounded', font:{size:12} };
            for (const [axis, scale] of Object.entries(options.scales || {})) {
                const numeric = options.indexAxis === 'y' ? axis === 'x' : axis === 'y';
                scale.border = {display:false};
                scale.grid = { ...scale.grid, display:numeric, color:'#302b36', lineWidth:1, drawTicks:false };
                scale.ticks = { ...scale.ticks, color:'#b6adbb', padding:8, maxRotation:0, autoSkip:true, font:{size:11} };
            }
            chart.data.datasets.forEach((dataset, index) => {
                const label = String(dataset.label || '').toLowerCase();
                let color = /resolv|safe/.test(label) ? colors.resolved : /active|emergen/.test(label) ? colors.active : /violation/.test(label) || chart.canvas.id === 'chart-violation-categories' ? colors.violations : /incident|occurrence/.test(label) ? colors.incidents : colors.secondary;
                if (chart.config.type === 'doughnut' || chart.config.type === 'pie') {
                    dataset.backgroundColor = chart.data.labels.map((name, i) => /resolv|safe/i.test(name) ? colors.resolved : /active|emergen/i.test(name) ? colors.active : Object.values(colors)[i % 5]);
                    dataset.borderColor = '#18151e';
                    dataset.borderWidth = 2;
                } else {
                    dataset.borderColor = color;
                    dataset.backgroundColor = chart.canvas.id === 'chart-escalation' ? [colors.secondary, colors.violations, colors.violations, colors.active] : chart.config.type === 'line' ? color + '18' : color;
                    dataset.borderWidth = chart.config.type === 'line' ? 2 : 0;
                    dataset.borderRadius = 3;
                    dataset.pointRadius = 2;
                    dataset.pointHoverRadius = 4;
                    dataset.pointBackgroundColor = color;
                    dataset.pointBorderColor = '#18151e';
                    dataset.tension = .25;
                }
            });
        }
    });
})();
