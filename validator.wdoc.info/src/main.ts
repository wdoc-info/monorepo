import { provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
bootstrapApplication(AppComponent, { providers: [provideZonelessChangeDetection()] })
    .catch(() => { document.body.textContent = 'The validator could not start. Please reload the page.'; });
