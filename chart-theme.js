/* Chart presentation shared by live analytics. Never changes source values. */
(() => {
 if (!window.Chart) return;
 const blue='#7bbde8', teal='#80c6bb', coral='#ed9e97', gold='#dfbd7a';
 Chart.register({
  id:'rescueProductTheme',
  beforeUpdate(chart) {
   const o=chart.config.options;
   o.animation=false;
   o.plugins ||= {};
   Object.assign(o.plugins.tooltip ||= {},{backgroundColor:'#001d39',titleColor:'#edf6fc',bodyColor:'#bdd8e9',borderColor:'#49769f',borderWidth:1,cornerRadius:10,padding:12,boxWidth:8,boxHeight:8});
   const legend=o.plugins.legend ||= {};
   legend.position='bottom';
   legend.labels={...legend.labels,color:'#bdd8e9',padding:18,usePointStyle:true,pointStyle:'circle',boxWidth:7,boxHeight:7,font:{size:11}};
   const donut=['doughnut','pie'].includes(chart.config.type);
   if(donut) o.cutout='74%';
   for(const [axis,s] of Object.entries(o.scales||{})) {
    const numeric=o.indexAxis==='y'?axis==='x':axis==='y';
    s.border={display:false};
    s.grid={...s.grid,display:numeric,color:'#21445b',drawTicks:false};
    s.ticks={...s.ticks,color:'#99b8cb',padding:8,maxRotation:0,autoSkip:true,font:{size:10}};
    if(axis==='x' && chart.config.type==='line')s.ticks.maxTicksLimit=7;
    if(numeric && chart.config.type==='bar')s.grace='18%';
    if(axis==='x' && chart.canvas.id==='chart-resolution'){
     s.ticks.autoSkip=false;s.ticks.font={size:9};
     s.ticks.callback=function(v){return this.getLabelForValue(v).replace(' min','');};
     s.title={display:true,text:'Minutes to resolution',color:'#99b8cb',font:{size:10}};
    }
   }
   chart.data.datasets.forEach((d,i)=>{
    const label=String(d.label||'');
    const color=/resolv|safe/i.test(label)?teal:/active|emergen/i.test(label)?coral:/violation/i.test(label)?gold:blue;
    if(donut){d.backgroundColor=chart.data.labels.map((s,j)=>/active/i.test(s)?coral:/resolv/i.test(s)?teal:[blue,'#49769f','#6ea2b3','#0a4174'][j%4]);d.borderColor='#0b3450';d.borderWidth=3;d.hoverOffset=4;return;}
    d.borderColor=color;d.borderWidth=chart.config.type==='line'?2:0;
    d.backgroundColor=chart.config.type==='line'?color+'12':color;
    if(chart.config.type==='bar'){
     d.maxBarThickness=22;d.categoryPercentage=.7;d.barPercentage=.75;d.borderRadius=4;
     if(chart.data.datasets.length===1 && !/resolution/.test(chart.canvas.id)){
      const max=Math.max(...d.data.map(Number));
      d.backgroundColor=d.data.map(v=>Number(v)===max&&max>0?blue:'#49769f');
     }
     if(chart.canvas.id==='chart-resolution')d.backgroundColor=[teal,teal,gold,gold,coral,coral];
    }
    d.tension=.28;d.pointRadius=chart.data.labels.length>16?0:2.5;d.pointHoverRadius=5;d.pointBackgroundColor=color;d.pointBorderColor='#082b46';
    if(chart.config.type==='line'){d.fill=true;d.pointBorderWidth=2;}
   });
  },
  afterDraw(chart){
   const {ctx,chartArea:a}=chart;if(!a)return;
   if(chart.config.type==='doughnut'){
    const total=chart.data.datasets[0].data.reduce((s,v)=>s+(Number(v)||0),0);
    const arc=chart.getDatasetMeta(0).data[0];const x=arc?arc.x:(a.left+a.right)/2,y=arc?arc.y:(a.top+a.bottom)/2;
    ctx.save();ctx.textAlign='center';ctx.fillStyle='#edf6fc';ctx.font='600 28px Inter, sans-serif';ctx.fillText(total.toLocaleString(),x,y+2);ctx.fillStyle='#99b8cb';ctx.font='11px Inter, sans-serif';ctx.fillText(chart.canvas.id==='chart-home-status'?'Classified incidents':'Total incidents',x,y+23);ctx.restore();
   }
   if(chart.config.type==='bar'&&chart.options.indexAxis!=='y'&&chart.data.labels.length<=14&&chart.data.datasets.length===1){
    ctx.save();ctx.textAlign='center';ctx.fillStyle='#bdd8e9';ctx.font='10px Inter, sans-serif';
    chart.getDatasetMeta(0).data.forEach((b,i)=>{const v=chart.data.datasets[0].data[i];if(Number(v)>0)ctx.fillText(v,b.x,Math.max(a.top+10,b.y-7));});ctx.restore();
   }
  }
 });
})();
