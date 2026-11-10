import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
function Form(){const [value,setValue]=useState('');return React.createElement('form',{onSubmit:event=>{event.preventDefault();window.result={value};document.querySelector('#result').textContent=JSON.stringify(window.result)}},React.createElement('label',null,'Customer name',React.createElement('input',{'aria-label':'Customer name',value,onChange:event=>setValue(event.target.value)})),React.createElement('button',{type:'submit'},'Save entry'))}
createRoot(document.querySelector('#react-root')).render(React.createElement(Form));
